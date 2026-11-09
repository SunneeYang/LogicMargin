package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"logicmargin/internal/review"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixtureReview() object {
	return object{"schemaVersion": float64(1), "id": "review-1", "title": "测试审查", "description": "核对原始流程", "revision": "r1",
		"snapshot": object{"repository": "test", "commit": "fixed", "fingerprint": strings.Repeat("a", 64), "capturedAt": "2026-11-02T00:00:00Z", "dirty": true},
		"coverage": object{"included": []any{}, "excluded": []any{}, "note": ""}, "scenes": []any{object{"id": "scene-1", "title": "流程", "description": ""}},
		"nodes": []any{object{"id": "node-1", "sceneId": "scene-1", "title": "检查", "kind": "action", "summary": "核对", "detail": "", "input": "", "output": "", "position": object{"x": float64(0), "y": float64(0)}, "evidence": []any{}}}, "edges": []any{}, "comments": []any{}}
}
func cloneObject(t *testing.T, v object) object {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var result object
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func firstEvidence(doc object) object { return obj(arr(obj(arr(doc["nodes"])[0])["evidence"])[0]) }
func addEvidence(doc object, path, code string, end int) {
	obj(arr(doc["nodes"])[0])["evidence"] = []any{object{"path": path, "symbol": "test", "startLine": float64(1), "endLine": float64(end), "digest": digest([]byte(code))}}
}
func sourceFixture(t *testing.T, entries map[string][]byte) (string, object) {
	t.Helper()
	root := t.TempDir()
	doc := fixtureReview()
	files := []object{}
	for path, content := range entries {
		target := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, content, 0600); err != nil {
			t.Fatal(err)
		}
		files = append(files, object{"path": path, "sha256": digest(content)})
	}
	sortManifest(files)
	values := make([]any, len(files))
	for i, file := range files {
		values[i] = file
	}
	obj(doc["snapshot"])["files"] = values
	obj(doc["snapshot"])["fingerprint"] = digest(manifestJSON(files))
	return root, doc
}
func sortManifest(files []object) {
	for i := 1; i < len(files); i++ {
		for j := i; j > 0 && utf16Less(str(files[j]["path"]), str(files[j-1]["path"])); j-- {
			files[j], files[j-1] = files[j-1], files[j]
		}
	}
}
func requireError(t *testing.T, err error, part string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), part) {
		t.Fatalf("error=%v, want %q", err, part)
	}
}

func TestSourceCaptureUTF8BOMCRLFAndManifest(t *testing.T) {
	entries := map[string][]byte{"z.md": []byte("规格\n"), "src/😀&.go": []byte("\ufeff检查😀\r\n执行()\r\n")}
	root, doc := sourceFixture(t, entries)
	addEvidence(doc, "src/😀&.go", "检查😀\n执行()", 2)
	ctx := context.Background()
	result, err := VerifySources(ctx, doc, root)
	if err != nil {
		t.Fatal(err)
	}
	if firstEvidence(doc)["code"] != "检查😀\n执行()" {
		t.Fatal(firstEvidence(doc))
	}
	files := arr(result["files"])
	if obj(files[0])["path"] != "src/😀&.go" || obj(files[0])["sha256"] != digest(entries["src/😀&.go"]) {
		t.Fatal(files)
	}
	if result["fingerprint"] != obj(doc["snapshot"])["fingerprint"] || !validDate(result["checkedAt"]) {
		t.Fatal(result)
	}
	if err := os.WriteFile(filepath.Join(root, "src/😀&.go"), []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if firstEvidence(doc)["code"] != "检查😀\n执行()" {
		t.Fatal("historical capture changed")
	}
}
func TestManifestJSONMatchesJavaScriptVector(t *testing.T) {
	files := []object{{"path": "😀<&>\u2028\\u2028\u2029", "sha256": strings.Repeat("a", 64)}}
	expected := `[{"path":"😀<&>` + "\u2028" + `\\u2028` + "\u2029" + `","sha256":"` + strings.Repeat("a", 64) + `"}]`
	if got := string(manifestJSON(files)); got != expected {
		t.Fatalf("got %q want %q", got, expected)
	}
	if !utf16Less("😀", "\ue000") || utf16Len("检查😀") != 4 {
		t.Fatal("JS UTF16 mismatch")
	}
}
func TestSourcesLegacyDocumentOnlyAndAtomicFailure(t *testing.T) {
	root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()\nrun()\n")})
	addEvidence(doc, "logic.go", "check()", 1)
	expected := obj(doc["snapshot"])["files"]
	delete(obj(doc["snapshot"]), "files")
	if _, err := VerifySources(context.Background(), doc, root); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(obj(doc["snapshot"])["files"], expected) {
		t.Fatal("legacy manifest mismatch")
	}
	firstEvidence(doc)["code"] = "forged()"
	obj(doc["snapshot"])["fingerprint"] = strings.Repeat("0", 64)
	before := cloneObject(t, doc)
	_, err := VerifySources(context.Background(), doc, root)
	requireError(t, err, "流程快照指纹与来源不符")
	if !reflect.DeepEqual(doc, before) {
		t.Fatal("partial update")
	}
	for _, content := range [][]byte{[]byte("规格"), {0xff, 0xfe}} {
		root, doc := sourceFixture(t, map[string][]byte{"requirements.bin": content})
		if _, err := VerifySources(context.Background(), doc, root); err != nil {
			t.Fatal("document-only:", err)
		}
	}
}
func TestSourceCaptureLimitsUseUTF16(t *testing.T) {
	cases := []struct {
		name, content string
		capture       bool
	}{
		{"chars-at-limit", strings.Repeat("😀", 50000), true},
		{"chars-over", strings.Repeat("😀", 50000) + "x", false},
		{"lines-at-limit", strings.Repeat("x\n", 1999) + "x", true},
		{"lines-over", strings.Repeat("x\n", 2000) + "x", false},
		{"nul", "a\x00b", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte(tc.content)})
			addEvidence(doc, "logic.go", tc.content, strings.Count(tc.content, "\n")+1)
			firstEvidence(doc)["code"] = "old"
			if _, err := VerifySources(context.Background(), doc, root); err != nil {
				t.Fatal(err)
			}
			_, ok := firstEvidence(doc)["code"]
			if ok != tc.capture {
				t.Fatalf("capture=%v want %v", ok, tc.capture)
			}
		})
	}
}
func TestSourceValidationAndPaths(t *testing.T) {
	for _, path := range []string{"../logic.go", "/logic.go", "C:/logic.go", "src\\logic.go", "src/./logic.go", "src//logic.go", "src/../logic.go", "a\x00b"} {
		t.Run(fmt.Sprintf("path-%q", path), func(t *testing.T) {
			root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()")})
			obj(arr(obj(doc["snapshot"])["files"])[0])["path"] = path
			_, err := VerifySources(context.Background(), doc, root)
			requireError(t, err, "规范相对路径")
		})
	}
	for _, tc := range []struct {
		name, part string
		change     func(string, object)
	}{
		{"filehash", "来源文件已变化", func(_ string, d object) { obj(arr(obj(d["snapshot"])["files"])[0])["sha256"] = strings.Repeat("0", 64) }},
		{"snippet", "源码依据已变化", func(_ string, d object) { firstEvidence(d)["digest"] = strings.Repeat("0", 64) }},
		{"range", "行号越界", func(_ string, d object) { firstEvidence(d)["endLine"] = float64(10) }},
		{"uncovered", "全部包含", func(_ string, d object) { firstEvidence(d)["path"] = "missing.go" }},
		{"missing", "no such file", func(root string, _ object) {
			if err := os.Remove(filepath.Join(root, "logic.go")); err != nil {
				t.Fatal(err)
			}
		}},
		{"directory", "普通文件", func(root string, _ object) {
			if err := os.Remove(filepath.Join(root, "logic.go")); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(filepath.Join(root, "logic.go"), 0700); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root, doc := sourceFixture(t, map[string][]byte{"logic.go": []byte("check()")})
			addEvidence(doc, "logic.go", "check()", 1)
			tc.change(root, doc)
			before := cloneObject(t, doc)
			_, err := VerifySources(context.Background(), doc, root)
			if tc.name == "missing" {
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("error=%v, want os.ErrNotExist", err)
				}
			} else {
				requireError(t, err, tc.part)
			}
			if !reflect.DeepEqual(doc, before) {
				t.Fatal("failed verification changed document")
			}
		})
	}
	root, doc := sourceFixture(t, map[string][]byte{"bad.go": {0xff, 0xfe}})
	addEvidence(doc, "bad.go", "unused", 1)
	_, err := VerifySources(context.Background(), doc, root)
	requireError(t, err, "有效 UTF-8")
	root, doc = sourceFixture(t, map[string][]byte{"logic.go": []byte("check()")})
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "logic.go"), []byte("check()"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "logic.go"), filepath.Join(root, "escape.go")); err != nil {
		t.Skip(err)
	}
	obj(arr(obj(doc["snapshot"])["files"])[0])["path"] = "escape.go"
	_, err = VerifySources(context.Background(), doc, root)
	requireError(t, err, "来源路径超出工作区")
}
func TestSourceFileAndTotalByteBounds(t *testing.T) {
	for _, tc := range []struct {
		name  string
		count int
		size  int64
	}{{"single-over", 1, maxFileBytes + 1}, {"total-over", 7, maxFileBytes}} {
		t.Run(tc.name, func(t *testing.T) {
			root, doc := sourceFixture(t, map[string][]byte{"initial": {}})
			files := []any{}
			zeroHash := digest(make([]byte, tc.size))
			for i := 0; i < tc.count; i++ {
				path := fmt.Sprintf("%d.go", i)
				f, err := os.Create(filepath.Join(root, path))
				if err != nil {
					t.Fatal(err)
				}
				err = f.Truncate(tc.size)
				_ = f.Close()
				if err != nil {
					t.Fatal(err)
				}
				files = append(files, object{"path": path, "sha256": zeroHash})
			}
			obj(doc["snapshot"])["files"] = files
			_, err := VerifySources(context.Background(), doc, root)
			requireError(t, err, "10 MB")
		})
	}
	root, doc := sourceFixture(t, map[string][]byte{"logic.go": bytes.Repeat([]byte{'x'}, maxFileBytes)})
	if _, err := VerifySources(context.Background(), doc, root); err != nil {
		t.Fatal("exact 10MB:", err)
	}
	budget := &sourceBudget{remaining: 3}
	f, err := os.Open(filepath.Join(root, "logic.go"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_, err = io.ReadAll(boundedSourceReader{context.Background(), f, budget})
	requireError(t, err, "64 MB")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	before := cloneObject(t, doc)
	_, err = VerifySources(ctx, doc, root)
	if err != context.Canceled || !reflect.DeepEqual(doc, before) {
		t.Fatal(err)
	}
}

func TestSourceErrorsRetainManifestOrder(t *testing.T) {
	root, doc := sourceFixture(t, map[string][]byte{"a.go": []byte("first"), "z.go": []byte("last")})
	obj(arr(obj(doc["snapshot"])["files"])[0])["sha256"] = strings.Repeat("0", 64)
	if err := os.Remove(filepath.Join(root, "z.go")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		_, err := VerifySources(context.Background(), doc, root)
		requireError(t, err, "来源文件已变化：a.go")
	}
}

func TestTypeScriptSourceOracle(t *testing.T) {
	var oracle struct {
		Cases []struct {
			Name             string
			Entries          []struct{ Path, Base64 string }
			Review, Expected object
			Codes            []any
		}
	}
	bytes, err := os.ReadFile(filepath.Join("testdata", "source-oracle.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(bytes, &oracle); err != nil {
		t.Fatal(err)
	}
	for _, tc := range oracle.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			root := t.TempDir()
			for _, entry := range tc.Entries {
				path := filepath.Join(root, entry.Path)
				content, err := base64.StdEncoding.DecodeString(entry.Base64)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, content, 0600); err != nil {
					t.Fatal(err)
				}
			}
			doc, err := review.ParseReview(tc.Review)
			if err != nil {
				t.Fatal(err)
			}
			got, err := VerifySources(context.Background(), doc, root)
			if err != nil {
				t.Fatal(err)
			}
			delete(got, "checkedAt")
			if !reflect.DeepEqual(got, tc.Expected) {
				t.Fatalf("Go source verification differs from fixed TS oracle: got %v, want %v", got, tc.Expected)
			}
			codes := []any{}
			for _, node := range arr(doc["nodes"]) {
				for _, evidence := range arr(obj(node)["evidence"]) {
					codes = append(codes, obj(evidence)["code"])
				}
			}
			if !reflect.DeepEqual(codes, tc.Codes) {
				t.Fatal("captured code differs from TypeScript oracle")
			}
		})
	}
}
