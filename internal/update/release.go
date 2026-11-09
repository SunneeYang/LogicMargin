// Package update implements the Codex-only, official-release local updater.
package update

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const repository = "https://github.com/SunneeYang/LogicMargin"
const releases = "https://api.github.com/repos/SunneeYang/LogicMargin/releases/"

var stable = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type Release struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	Newer   bool   `json:"newer"`
}

type releaseHTTPError int

func (status releaseHTTPError) Error() string { return fmt.Sprintf("release_http_%d", status) }

func versionParts(v string) ([3]uint64, error) {
	var parts [3]uint64
	if !stable.MatchString(v) {
		return parts, errors.New("invalid_version")
	}
	for i, p := range strings.Split(v, ".") {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return parts, errors.New("invalid_version")
		}
		parts[i] = n
	}
	return parts, nil
}
func newer(a, b string) (bool, error) {
	aa, err := versionParts(a)
	if err != nil {
		return false, err
	}
	bb, err := versionParts(b)
	if err != nil {
		return false, err
	}
	for i := range aa {
		if aa[i] != bb[i] {
			return aa[i] > bb[i], nil
		}
	}
	return false, nil
}
func Target(goos, arch string) (string, error) {
	if arch == "amd64" {
		arch = "x64"
	}
	if goos == "windows" {
		goos = "win32"
	}
	target := goos + "-" + arch
	switch target {
	case "darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64":
		return target, nil
	}
	return "", errors.New("unsupported_platform")
}
func releaseClient() *http.Client {
	return &http.Client{Timeout: 2 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		h := req.URL.Hostname()
		if len(via) > 5 || req.URL.Scheme != "https" || (h != "github.com" && h != "api.github.com" && h != "release-assets.githubusercontent.com" && h != "objects.githubusercontent.com") {
			return errors.New("untrusted_release_redirect")
		}
		return nil
	}}
}
func get(ctx context.Context, client *http.Client, raw string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "LogicMargin-release-update")
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("release_unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, releaseHTTPError(res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("release_size_limit")
	}
	if raw == repository+"/releases/latest" {
		var info struct {
			Tag string `json:"tag_name"`
		}
		// The website fallback must resolve to this repository's exact release tag.
		if json.Unmarshal(b, &info) != nil || res.Request == nil || res.Request.URL.String() != repository+"/releases/tag/"+info.Tag {
			return nil, errors.New("invalid_release")
		}
	}
	return b, nil
}
func check(ctx context.Context, client *http.Client, current, requested string) (Release, error) {
	endpoint := "latest"
	if requested != "" {
		if _, err := versionParts(requested); err != nil {
			return Release{}, err
		}
		endpoint = "tags/v" + requested
	}
	b, err := get(ctx, client, releases+endpoint, 1024*1024)
	var status releaseHTTPError
	if errors.As(err, &status) && (status == http.StatusForbidden || status == http.StatusTooManyRequests) {
		b, err = get(ctx, client, repository+"/releases/latest", 1024*1024)
	}
	if err != nil {
		return Release{}, err
	}
	var info struct {
		Tag        string `json:"tag_name"`
		Draft      bool
		Prerelease bool
	}
	if json.Unmarshal(b, &info) != nil || !strings.HasPrefix(info.Tag, "v") || info.Draft || info.Prerelease {
		return Release{}, errors.New("invalid_release")
	}
	v := strings.TrimPrefix(info.Tag, "v")
	if requested != "" && v != requested {
		return Release{}, errors.New("release_version_mismatch")
	}
	n, err := newer(v, current)
	if err != nil {
		return Release{}, err
	}
	return Release{v, repository + "/releases/tag/v" + v, n}, nil
}
func Check(ctx context.Context, current string) (Release, error) {
	return check(ctx, releaseClient(), current, "")
}

func download(ctx context.Context, client *http.Client, version, directory string) (string, error) {
	target, err := Target(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return "", err
	}
	name := "logic-margin-agent-" + version + "-" + target
	asset := name + ".zip"
	base := repository + "/releases/download/v" + version + "/" + asset
	sum, err := get(ctx, client, base+".sha256", 4096)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(sum))
	if len(fields) != 2 || len(fields[0]) != 64 || fields[1] != asset {
		return "", errors.New("invalid_checksum")
	}
	expected, err := hex.DecodeString(fields[0])
	if err != nil {
		return "", errors.New("invalid_checksum")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base, nil)
	res, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", errors.New("release_unreachable")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", errors.New("archive_download_failed")
	}
	archive := filepath.Join(directory, asset)
	f, err := os.OpenFile(archive, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(f, hash), io.LimitReader(res.Body, 256*1024*1024+1))
	closeErr := f.Close()
	if copyErr != nil {
		return "", copyErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n > 256*1024*1024 {
		return "", errors.New("archive_size_limit")
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), hex.EncodeToString(expected)) {
		return "", errors.New("checksum_mismatch")
	}
	root := filepath.Join(directory, name)
	if err := extract(ctx, archive, directory, name); err != nil {
		return "", err
	}
	binary := "logic-margin"
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	return filepath.Join(root, "plugins", "logic-margin", "skills", "logic-margin", "scripts", binary), nil
}
func extract(ctx context.Context, archive, dest, root string) error {
	z, err := zip.OpenReader(archive)
	if err != nil {
		return errors.New("invalid_archive")
	}
	defer z.Close()
	var total uint64
	seen := map[string]bool{}
	for _, entry := range z.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := entry.Name
		if !filepath.IsLocal(filepath.FromSlash(name)) || !strings.HasPrefix(name, root+"/") || strings.ContainsAny(name, "\\:\x00") || path.Clean(name) != strings.TrimSuffix(name, "/") || entry.Mode()&os.ModeSymlink != 0 || (!entry.FileInfo().IsDir() && !entry.Mode().IsRegular()) || seen[name] {
			return errors.New("unsafe_archive")
		}
		seen[name] = true
		total += entry.UncompressedSize64
		if total > 512*1024*1024 || len(seen) > 10000 {
			return errors.New("archive_size_limit")
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		input, err := entry.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			input.Close()
			return err
		}
		_, err = io.Copy(output, io.LimitReader(input, 512*1024*1024+1))
		inErr := input.Close()
		outErr := output.Close()
		if err != nil {
			return err
		}
		if inErr != nil {
			return inErr
		}
		if outErr != nil {
			return outErr
		}
	}
	return nil
}
