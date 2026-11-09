package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"logicmargin/internal/review"
	"logicmargin/internal/sourcecontext"
)

const maxFileBytes = 10 * 1024 * 1024
const maxTotalBytes = 64 * 1024 * 1024
const maxCodeChars = 100000
const maxCodeLines = 2000

var sourceSizeError = errors.New("来源文件超过单文件 10 MB 或总计 64 MB 上限")

func digest(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

// JSON.stringify uses literal Unicode and this exact manifest field order.
func manifestJSON(files []object) []byte {
	var b strings.Builder
	quote := func(s string) {
		b.WriteByte('"')
		for _, r := range s {
			switch r {
			case '"', '\\':
				b.WriteByte('\\')
				b.WriteRune(r)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			default:
				if r < 32 {
					fmt.Fprintf(&b, `\u%04x`, r)
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	}
	b.WriteByte('[')
	for i, file := range files {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"path":`)
		quote(str(file["path"]))
		b.WriteString(`,"sha256":`)
		quote(str(file["sha256"]))
		b.WriteByte('}')
	}
	b.WriteByte(']')
	return []byte(b.String())
}

type sourceBudget struct {
	sync.Mutex
	remaining int64
}
type boundedSourceReader struct {
	ctx    context.Context
	file   *os.File
	budget *sourceBudget
}

func (r boundedSourceReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	r.budget.Lock()
	defer r.budget.Unlock()
	if int64(len(p)) > r.budget.remaining+1 {
		p = p[:r.budget.remaining+1]
	}
	n, err := r.file.Read(p)
	r.budget.remaining -= int64(n)
	if r.budget.remaining < 0 {
		return n, sourceSizeError
	}
	return n, err
}

type sourceResult struct {
	file   object
	codes  map[int]string
	source *sourcecontext.Source
	err    error
}

// VerifySources captures only the current document. Historical baselines are
// verified separately against their explicitly supplied original workspace.
func VerifySources(ctx context.Context, doc review.Object, sourceRoot string) (review.Object, error) {
	return verifySources(ctx, doc, sourceRoot, nil)
}

// VerifySourcesWithContexts returns optional analysis inputs from the same reads
// that verified the manifest. Failed verification never exposes partial inputs.
func VerifySourcesWithContexts(ctx context.Context, doc review.Object, sourceRoot string) (review.Object, []sourcecontext.Source, error) {
	var sources []sourcecontext.Source
	report, err := verifySources(ctx, doc, sourceRoot, &sources)
	if err != nil {
		return nil, nil, err
	}
	return report, sources, nil
}

func verifySources(ctx context.Context, doc review.Object, sourceRoot string, contexts *[]sourcecontext.Source) (review.Object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rootPath, err := filepath.Abs(sourceRoot)
	if err != nil {
		return nil, err
	}
	rootPath, err = filepath.EvalSymlinks(rootPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(rootPath)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("来源工作区必须是目录")
	}
	root, err := os.OpenRoot(rootPath)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	snapshot := obj(doc["snapshot"])
	if snapshot == nil {
		return nil, errors.New("代码快照必须是对象")
	}
	evidence := []object{}
	for _, rawNode := range arr(doc["nodes"]) {
		for _, item := range arr(obj(rawNode)["evidence"]) {
			if obj(item) == nil {
				return nil, errors.New("源码依据必须是对象")
			}
			evidence = append(evidence, obj(item))
		}
	}
	declared, hasDeclared := snapshot["files"]
	if !hasDeclared {
		selected, seen := []any{}, map[string]bool{}
		for _, item := range evidence {
			path := str(item["path"])
			if !seen[path] {
				selected = append(selected, object{"path": path, "sha256": strings.Repeat("0", 64)})
				seen[path] = true
			}
		}
		declared = selected
	}
	files, err := review.ParseSourceFiles(declared)
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return utf16Less(str(files[i]["path"]), str(files[j]["path"])) })
	covered := map[string]bool{}
	references := map[string][]int{}
	for _, file := range files {
		covered[str(file["path"])] = true
	}
	for i, item := range evidence {
		path := str(item["path"])
		if !covered[path] {
			return nil, errors.New("图内源码依据必须全部包含在来源文件清单中")
		}
		references[path] = append(references[path], i)
	}
	// Record preflight failures in manifest order so concurrency never changes
	// which source error wins. Workers still open through the confined root.
	paths := make([]string, len(files))
	results := make([]sourceResult, len(files))
	var planned int64
	for i, file := range files {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		path := str(file["path"])
		resolved, err := filepath.EvalSymlinks(filepath.Join(rootPath, filepath.FromSlash(path)))
		if err != nil {
			results[i].err = err
			continue
		}
		rel, err := filepath.Rel(rootPath, resolved)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			results[i].err = fmt.Errorf("来源路径超出工作区：%s", path)
			continue
		}
		stat, err := root.Stat(rel)
		if err != nil {
			results[i].err = err
			continue
		}
		if !stat.Mode().IsRegular() {
			results[i].err = fmt.Errorf("来源必须是普通文件：%s", path)
			continue
		}
		planned += stat.Size()
		if stat.Size() > maxFileBytes || planned > maxTotalBytes {
			results[i].err = sourceSizeError
			continue
		}
		paths[i] = rel
	}
	jobs := make(chan int)
	budget := &sourceBudget{remaining: maxTotalBytes}
	var workers sync.WaitGroup
	for worker := 0; worker < min(4, len(files)); worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := range jobs {
				results[i] = verifySource(ctx, root, paths[i], files[i], hasDeclared, evidence, references[str(files[i]["path"])], budget, contexts != nil)
			}
		}()
	}
	for i := range files {
		if results[i].err == nil {
			jobs <- i
		}
	}
	close(jobs)
	workers.Wait()
	checked := make([]object, len(files))
	captured := map[int]string{}
	for i, result := range results {
		if result.err != nil {
			return nil, result.err
		}
		checked[i] = result.file
		for index, code := range result.codes {
			captured[index] = code
		}
	}
	fingerprint := digest(manifestJSON(checked))
	if snapshot["fingerprint"] != fingerprint {
		return nil, fmt.Errorf("流程快照指纹与来源不符；当前指纹为 %s，请重新核对流程后更新评审文件", fingerprint)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	nodes := make([]any, 0, len(arr(doc["nodes"])))
	index := 0
	for _, rawNode := range arr(doc["nodes"]) {
		node := copyObject(obj(rawNode))
		refs := make([]any, 0, len(arr(node["evidence"])))
		for _, rawItem := range arr(node["evidence"]) {
			item := copyObject(obj(rawItem))
			delete(item, "code")
			if code, ok := captured[index]; ok {
				item["code"] = code
			}
			refs = append(refs, item)
			index++
		}
		node["evidence"] = refs
		nodes = append(nodes, node)
	}
	nextSnapshot := copyObject(snapshot)
	manifest := make([]any, len(checked))
	for i, file := range checked {
		manifest[i] = file
	}
	nextSnapshot["files"] = manifest
	// Publish together only after every source, snippet and fingerprint succeeded.
	doc["nodes"], doc["snapshot"] = nodes, nextSnapshot
	if contexts != nil {
		for _, result := range results {
			if result.source != nil {
				*contexts = append(*contexts, *result.source)
			}
		}
	}
	return object{"algorithm": "sha256-path-content-v1", "checkedAt": now(), "files": manifest, "fingerprint": fingerprint}, nil
}

func verifySource(ctx context.Context, root *os.Root, rel string, file object, declared bool, evidence []object, indexes []int, budget *sourceBudget, captureContext bool) (result sourceResult) {
	fail := func(err error) sourceResult { return sourceResult{err: err} }
	if err := ctx.Err(); err != nil {
		return fail(err)
	}
	path := str(file["path"])
	// os.Root prevents a swapped symlink from escaping after the earlier realpath check.
	f, err := root.Open(rel)
	if err != nil {
		return fail(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if !info.Mode().IsRegular() {
		return fail(fmt.Errorf("来源必须是普通文件：%s", path))
	}
	if info.Size() > maxFileBytes {
		return fail(sourceSizeError)
	}
	raw, err := io.ReadAll(io.LimitReader(boundedSourceReader{ctx, f, budget}, maxFileBytes+1))
	if err != nil {
		return fail(err)
	}
	if len(raw) > maxFileBytes {
		return fail(sourceSizeError)
	}
	hash := digest(raw)
	if declared && file["sha256"] != hash {
		return fail(fmt.Errorf("来源文件已变化：%s；当前 SHA-256 为 %s，请重新核对流程并更新清单", path, hash))
	}
	result.file = object{"path": path, "sha256": hash}
	result.codes = map[int]string{}
	if len(indexes) == 0 {
		return result
	}
	if !utf8.Valid(raw) {
		return fail(fmt.Errorf("源码依据不是有效 UTF-8 文本：%s", path))
	}
	content := string(raw)
	if captureContext && len(raw) <= sourcecontext.MaxFileBytes && !bytes.ContainsRune(raw, 0) && contains(strings.ToLower(filepath.Ext(path)), ".go", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx") {
		result.source = &sourcecontext.Source{Path: path, SHA256: hash, Content: content}
	}
	content = strings.TrimPrefix(content, "\ufeff")
	content = strings.ReplaceAll(content, "\r\n", "\n")
	// Keep offsets only for referenced boundaries, even for newline-heavy files.
	offsets := map[int]int{1: 0}
	for _, index := range indexes {
		item := evidence[index]
		for _, key := range []string{"startLine", "endLine"} {
			value := number(item[key])
			if safeInteger(item[key]) && value >= 1 && value <= float64(len(content)+1) {
				line := int(value)
				if key == "endLine" {
					line++
				}
				offsets[line] = 0
			}
		}
	}
	lineCount := 1
	for i := range content {
		if content[i] == '\n' {
			lineCount++
			if _, wanted := offsets[lineCount]; wanted {
				offsets[lineCount] = i + 1
			}
		}
	}
	for _, index := range indexes {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		item := evidence[index]
		start, end := number(item["startLine"]), number(item["endLine"])
		if !safeInteger(item["startLine"]) || !safeInteger(item["endLine"]) || start < 1 || end < start || end > float64(lineCount) {
			return fail(fmt.Errorf("源码依据行号越界：%s:%v–%v", path, start, end))
		}
		stop := len(content)
		if int(end) < lineCount {
			stop = offsets[int(end)+1] - 1
		}
		code := content[offsets[int(start)]:stop]
		actual := digest([]byte(code))
		if item["digest"] != actual {
			return fail(fmt.Errorf("源码依据已变化：%s:%v–%v；当前片段 SHA-256 为 %s，请更新流程及依据", path, start, end, actual))
		}
		if end-start+1 <= maxCodeLines && utf16Len(code) <= maxCodeChars && !strings.ContainsRune(code, 0) {
			result.codes[index] = code
		}
	}
	return result
}
