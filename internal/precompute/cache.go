package precompute

import (
	"container/list"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"time"

	"logicmargin/internal/daemon"
)

const memoryBudget = 32 * 1024 * 1024
const inputBudget = 64 * 1024 * 1024
const diskBudget = 128 * 1024 * 1024
const maxArtifactBytes = 8 * 1024 * 1024
const maxDiskEntries = 1024

var ErrBusy = errors.New("预计算任务繁忙，请稍后重试")
var ErrClosed = errors.New("预计算服务已停止")
var cacheFileName = regexp.MustCompile(`^artifact-v1-[a-f0-9]{64}\.json$`)
var cacheTempName = regexp.MustCompile(`^artifact-v1-[a-f0-9]{64}\.json\.([1-9][0-9]*)\.[A-Z2-7]{26}\.tmp$`)

type Stats struct {
	Computations, MemoryHits, DiskHits, Shared, DiskErrors, Failures uint64
	Active, PeakActive, InFlight, MemoryBytes                        int
}
type cachedArtifact struct {
	key string
	raw []byte
}
type artifactJob struct {
	key     string
	bytes   int
	compute func(context.Context) ([]byte, error)
	done    chan struct{}
	raw     []byte
	err     error
	status  string
}
type diskArtifact struct {
	SchemaVersion int             `json:"schemaVersion"`
	Key           string          `json:"key"`
	Checksum      string          `json:"checksum"`
	Data          json.RawMessage `json:"data"`
}

type Engine struct {
	ctx                     context.Context
	cancel                  context.CancelFunc
	cacheDir                string
	mu                      sync.Mutex
	diskMu                  sync.Mutex
	closed                  bool
	once                    sync.Once
	workers                 sync.WaitGroup
	cache                   map[string]*list.Element
	lru                     *list.List
	memoryBytes, inputBytes int
	inFlight                map[string]*artifactJob
	queue                   chan *artifactJob
	stats                   Stats
}

func NewEngine(cacheDir string) *Engine {
	ctx, cancel := context.WithCancel(context.Background())
	e := &Engine{ctx: ctx, cancel: cancel, cacheDir: cacheDir, cache: map[string]*list.Element{}, lru: list.New(), inFlight: map[string]*artifactJob{}, queue: make(chan *artifactJob, 32)}
	if cacheDir != "" {
		e.pruneDisk()
	}
	for i := 0; i < min(4, max(1, runtime.GOMAXPROCS(0))); i++ {
		e.workers.Add(1)
		go e.worker()
	}
	return e
}

func artifactDigest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func artifactKey(kind string, input any) string {
	raw, _ := json.Marshal([]any{SchemaVersion, kind, input})
	return artifactDigest(raw)
}

func (e *Engine) get(ctx context.Context, key string, inputBytes int, compute func(context.Context) ([]byte, error)) (json.RawMessage, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil, "", ErrClosed
	}
	if entry := e.cache[key]; entry != nil {
		e.lru.MoveToBack(entry)
		e.stats.MemoryHits++
		raw := append(json.RawMessage(nil), entry.Value.(*cachedArtifact).raw...)
		e.mu.Unlock()
		return raw, "memory", nil
	}
	job := e.inFlight[key]
	status := "shared"
	if job != nil {
		e.stats.Shared++
	} else {
		if e.inputBytes+inputBytes > inputBudget {
			e.mu.Unlock()
			return nil, "", ErrBusy
		}
		job = &artifactJob{key: key, bytes: inputBytes, compute: compute, done: make(chan struct{})}
		e.inFlight[key] = job
		e.inputBytes += inputBytes
		select {
		case e.queue <- job:
		default:
			delete(e.inFlight, key)
			e.inputBytes -= inputBytes
			e.mu.Unlock()
			return nil, "", ErrBusy
		}
		status = "miss"
	}
	e.mu.Unlock()
	select {
	case <-ctx.Done():
		return nil, "", ctx.Err()
	case <-job.done:
		if status == "miss" {
			status = job.status
		}
		return append(json.RawMessage(nil), job.raw...), status, job.err
	}
}

func (e *Engine) worker() {
	defer e.workers.Done()
	for {
		if e.ctx.Err() != nil {
			return
		}
		select {
		case <-e.ctx.Done():
			return
		case job := <-e.queue:
			if e.ctx.Err() != nil {
				e.finish(job, nil, ErrClosed, "miss")
				continue
			}
			if raw := e.readDisk(job.key); raw != nil {
				e.mu.Lock()
				e.stats.DiskHits++
				e.mu.Unlock()
				e.finish(job, raw, nil, "disk")
				continue
			}
			e.mu.Lock()
			e.stats.Active++
			e.stats.Computations++
			e.stats.PeakActive = max(e.stats.PeakActive, e.stats.Active)
			e.mu.Unlock()
			ctx, cancel := context.WithTimeout(e.ctx, 4*time.Second)
			raw, err := computeArtifact(ctx, job.compute)
			if err == nil {
				err = ctx.Err()
			}
			cancel()
			e.mu.Lock()
			e.stats.Active--
			if err != nil {
				e.stats.Failures++
			}
			e.mu.Unlock()
			if len(raw) > maxArtifactBytes {
				raw = nil
				err = errors.New("预计算结果超过缓存容量")
			}
			if err == nil {
				e.writeDisk(job.key, raw)
			}
			e.finish(job, raw, err, "miss")
		}
	}
}

func computeArtifact(ctx context.Context, fn func(context.Context) ([]byte, error)) (raw []byte, err error) {
	defer func() {
		if recover() != nil {
			raw = nil
			err = errors.New("预计算失败")
		}
	}()
	return fn(ctx)
}

func (e *Engine) finish(job *artifactJob, raw []byte, err error, status string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.inFlight[job.key] != job {
		return
	}
	delete(e.inFlight, job.key)
	e.inputBytes -= job.bytes
	if e.closed {
		err = ErrClosed
		raw = nil
	}
	if err == nil {
		if entry := e.cache[job.key]; entry != nil {
			e.memoryBytes -= len(entry.Value.(*cachedArtifact).raw)
			e.lru.Remove(entry)
		}
		e.cache[job.key] = e.lru.PushBack(&cachedArtifact{job.key, append([]byte(nil), raw...)})
		e.memoryBytes += len(raw)
		for e.memoryBytes > memoryBudget || e.lru.Len() > 64 {
			first := e.lru.Front()
			entry := first.Value.(*cachedArtifact)
			e.memoryBytes -= len(entry.raw)
			delete(e.cache, entry.key)
			e.lru.Remove(first)
		}
	}
	job.raw, job.err, job.status = raw, err, status
	close(job.done)
}

func (e *Engine) Stats() Stats {
	e.mu.Lock()
	defer e.mu.Unlock()
	stats := e.stats
	stats.InFlight = len(e.inFlight)
	stats.MemoryBytes = e.memoryBytes
	return stats
}

func (e *Engine) Close() {
	e.once.Do(func() {
		e.mu.Lock()
		e.closed = true
		e.mu.Unlock()
		e.cancel()
		e.workers.Wait()
		e.mu.Lock()
		jobs := make([]*artifactJob, 0, len(e.inFlight))
		for _, job := range e.inFlight {
			jobs = append(jobs, job)
		}
		e.mu.Unlock()
		for _, job := range jobs {
			e.finish(job, nil, ErrClosed, "miss")
		}
	})
}

func (e *Engine) diskError() { e.mu.Lock(); e.stats.DiskErrors++; e.mu.Unlock() }
func (e *Engine) diskPath(key string) string {
	return filepath.Join(e.cacheDir, "artifact-v1-"+key+".json")
}

func (e *Engine) readDisk(key string) []byte {
	if e.cacheDir == "" {
		return nil
	}
	file, err := os.Open(e.diskPath(key))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		e.diskError()
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxArtifactBytes+4097))
	_ = file.Close()
	var value diskArtifact
	if err != nil || len(raw) > maxArtifactBytes+4096 || json.Unmarshal(raw, &value) != nil || value.SchemaVersion != SchemaVersion || value.Key != key || len(value.Data) == 0 || len(value.Data) > maxArtifactBytes || value.Checksum != artifactDigest(value.Data) {
		e.diskError()
		_ = os.Remove(e.diskPath(key))
		return nil
	}
	var header struct {
		SchemaVersion int    `json:"schemaVersion"`
		Key           string `json:"key"`
		Algorithm     string `json:"algorithm"`
	}
	if json.Unmarshal(value.Data, &header) != nil || header.SchemaVersion != SchemaVersion || header.Key != key || header.Algorithm == "" {
		e.diskError()
		_ = os.Remove(e.diskPath(key))
		return nil
	}
	_ = os.Chtimes(e.diskPath(key), time.Now(), time.Now())
	return value.Data
}

func (e *Engine) writeDisk(key string, data []byte) {
	if e.cacheDir == "" {
		return
	}
	e.diskMu.Lock()
	defer e.diskMu.Unlock()
	if err := os.MkdirAll(e.cacheDir, 0700); err != nil {
		e.diskError()
		return
	}
	raw, err := json.Marshal(diskArtifact{SchemaVersion, key, artifactDigest(data), data})
	if err != nil {
		e.diskError()
		return
	}
	path := e.diskPath(key)
	temporary := path + "." + strconv.Itoa(os.Getpid()) + "." + rand.Text() + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		e.diskError()
		return
	}
	defer os.Remove(temporary)
	_, err = file.Write(raw)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temporary, path)
	}
	if err != nil {
		e.diskError()
		return
	}
	e.pruneDisk()
}

func (e *Engine) pruneDisk() {
	entries, err := os.ReadDir(e.cacheDir)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		e.diskError()
		return
	}
	type saved struct {
		name  string
		bytes int64
		used  time.Time
	}
	files := []saved{}
	var total int64
	for _, entry := range entries {
		if match := cacheTempName.FindStringSubmatch(entry.Name()); match != nil && entry.Type().IsRegular() {
			pid, err := strconv.Atoi(match[1])
			if err == nil && !daemon.ProcessAlive(pid) {
				if err := os.Remove(filepath.Join(e.cacheDir, entry.Name())); err != nil {
					e.diskError()
				}
			}
			continue
		}
		if !cacheFileName.MatchString(entry.Name()) || entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, saved{entry.Name(), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].used.Before(files[j].used) })
	remaining := len(files)
	for _, file := range files {
		if total <= diskBudget && remaining <= maxDiskEntries {
			break
		}
		if err := os.Remove(filepath.Join(e.cacheDir, file.name)); err != nil {
			e.diskError()
			continue
		}
		total -= file.bytes
		remaining--
	}
}
