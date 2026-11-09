// Package sourcecontext stores disposable, verified full-source analysis inputs.
package sourcecontext

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const MaxFileBytes = 2 * 1024 * 1024

// JSON can expand each source byte to six bytes, plus the bounded identity fields.
const maxEntryBytes = 6*MaxFileBytes + 16*1024

type Source struct {
	Path    string `json:"path"`
	SHA256  string `json:"sha256"`
	Content string `json:"content"`
}

type Store struct {
	directory  string
	budget     int64
	maxEntries int
}

// Serialize stores in this process too, so reopening a directory preserves quota.
var storeMu sync.Mutex
var sessionPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var entryPattern = regexp.MustCompile(`^[a-f0-9]{64}\.json\.gz$`)
var tempPattern = regexp.MustCompile(`^\.source-context-[a-f0-9]{32}\.tmp$`)

type entry struct {
	SessionID string `json:"sessionId"`
	Source    Source `json:"source"`
}

func NewStore(directory string) *Store {
	return &Store{directory: directory, budget: 256 * 1024 * 1024, maxEntries: 4096}
}

func sum(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

func validateIdentity(sessionID, p, sha string) error {
	if !sessionPattern.MatchString(sessionID) || !hashPattern.MatchString(sha) {
		return errors.New("invalid source context session or SHA-256")
	}
	if p == "" || len(p) > 8000 || !utf8.ValidString(p) || strings.TrimSpace(p) != p || path.Clean(p) != p || strings.HasPrefix(p, "/") || p == "." || p == ".." || strings.HasPrefix(p, "../") || strings.ContainsAny(p, `\:`) {
		return errors.New("source context path must be a canonical relative path")
	}
	units := 0
	for _, r := range p {
		if r < 32 || r == 127 {
			return errors.New("invalid source context path")
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	if units > 2000 {
		return errors.New("source context path is too long")
	}
	return nil
}

func validateSource(source Source) error {
	if len(source.Content) > MaxFileBytes || !utf8.ValidString(source.Content) || strings.ContainsRune(source.Content, 0) || sum(source.Content) != source.SHA256 {
		return errors.New("invalid source context content or SHA-256")
	}
	return nil
}

func filename(sessionID, p, sha string) string {
	return sum(sessionID+"\x00"+p+"\x00"+sha) + ".json.gz"
}

func (s *Store) open(create bool) (*os.Root, error) {
	abs, err := filepath.Abs(s.directory)
	if err != nil {
		return nil, err
	}
	anchor := filepath.VolumeName(abs) + string(filepath.Separator)
	root, err := os.OpenRoot(anchor)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(strings.TrimPrefix(abs, anchor), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		info, err := root.Lstat(part)
		if errors.Is(err, os.ErrNotExist) && create {
			if err = root.Mkdir(part, 0700); err == nil || errors.Is(err, os.ErrExist) {
				info, err = root.Lstat(part)
			}
		}
		if err != nil {
			root.Close()
			return nil, err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			root.Close()
			return nil, errors.New("source context directory must not contain symlinks")
		}
		next, err := root.OpenRoot(part)
		root.Close()
		if err != nil {
			return nil, err
		}
		opened, err := next.Stat(".")
		if err != nil || !os.SameFile(info, opened) {
			next.Close()
			return nil, errors.New("source context directory changed while opening")
		}
		root = next
	}
	return root, nil
}

type diskEntry struct {
	name string
	size int64
	time time.Time
}

// Reserve space before creating a temporary file; only recognized cache entries
// and abandoned temporary files in this dedicated directory may be removed.
func (s *Store) reserve(ctx context.Context, root *os.Root, size int64) error {
	dir, err := root.Open(".")
	if err != nil {
		return err
	}
	defer dir.Close()
	var total int64
	var entries []diskEntry
	count := 0
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		batch, err := dir.ReadDir(128)
		if err != nil && err != io.EOF {
			return err
		}
		for _, item := range batch {
			info, err := item.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return errors.New("unexpected non-regular source context cache entry")
			}
			if tempPattern.MatchString(item.Name()) && time.Since(info.ModTime()) > time.Hour {
				if err := root.Remove(item.Name()); err != nil {
					return err
				}
				continue
			}
			total += info.Size()
			count++
			if entryPattern.MatchString(item.Name()) {
				entries = append(entries, diskEntry{item.Name(), info.Size(), info.ModTime()})
			}
		}
		if err == io.EOF {
			break
		}
	}
	if size > s.budget || s.maxEntries < 1 {
		return errors.New("source context exceeds cache quota")
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].time.Equal(entries[j].time) {
			return entries[i].name < entries[j].name
		}
		return entries[i].time.Before(entries[j].time)
	})
	for _, item := range entries {
		if total+size <= s.budget && count+1 <= s.maxEntries {
			break
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := root.Remove(item.name); err != nil {
			return err
		}
		total -= item.size
		count--
	}
	if total+size > s.budget || count+1 > s.maxEntries {
		return errors.New("source context cache quota unavailable")
	}
	return nil
}

func (s *Store) Put(ctx context.Context, sessionID string, source Source) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateIdentity(sessionID, source.Path, source.SHA256); err != nil {
		return err
	}
	if err := validateSource(source); err != nil {
		return err
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := s.open(true)
	if err != nil {
		return err
	}
	defer root.Close()
	if existing, err := get(ctx, root, sessionID, source.Path, source.SHA256); err == nil && existing == source {
		return nil
	}
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if err := json.NewEncoder(gz).Encode(entry{sessionID, source}); err != nil {
		gz.Close()
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := s.reserve(ctx, root, int64(compressed.Len())); err != nil {
		return err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	tmp := ".source-context-" + hex.EncodeToString(random[:]) + ".tmp"
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, err = f.Write(compressed.Bytes())
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return root.Rename(tmp, filename(sessionID, source.Path, source.SHA256))
}

func (s *Store) Get(ctx context.Context, sessionID, p, sha string) (Source, error) {
	if err := ctx.Err(); err != nil {
		return Source{}, err
	}
	if err := validateIdentity(sessionID, p, sha); err != nil {
		return Source{}, err
	}
	storeMu.Lock()
	defer storeMu.Unlock()
	if err := ctx.Err(); err != nil {
		return Source{}, err
	}
	root, err := s.open(false)
	if err != nil {
		return Source{}, err
	}
	defer root.Close()
	return get(ctx, root, sessionID, p, sha)
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func get(ctx context.Context, root *os.Root, sessionID, p, sha string) (Source, error) {
	name := filename(sessionID, p, sha)
	info, err := root.Lstat(name)
	if err != nil {
		return Source{}, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxEntryBytes {
		return Source{}, errors.New("invalid source context cache file")
	}
	f, err := root.Open(name)
	if err != nil {
		return Source{}, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return Source{}, errors.New("source context cache file changed while opening")
	}
	gz, err := gzip.NewReader(contextReader{ctx, io.LimitReader(f, maxEntryBytes+1)})
	if err != nil {
		return Source{}, err
	}
	defer gz.Close()
	raw, err := io.ReadAll(io.LimitReader(contextReader{ctx, gz}, maxEntryBytes+1))
	if err != nil {
		return Source{}, err
	}
	if len(raw) > maxEntryBytes || !utf8.Valid(raw) {
		return Source{}, errors.New("source context cache exceeds decoded limit or is invalid UTF-8")
	}
	var stored entry
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		return Source{}, err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return Source{}, errors.New("unexpected trailing source context data")
	}
	if stored.SessionID != sessionID || stored.Source.Path != p || stored.Source.SHA256 != sha {
		return Source{}, errors.New("source context identity mismatch")
	}
	if err := validateSource(stored.Source); err != nil {
		return Source{}, fmt.Errorf("corrupt source context: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return Source{}, err
	}
	return stored.Source, nil
}
