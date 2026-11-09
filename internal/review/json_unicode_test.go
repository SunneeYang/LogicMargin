package review

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJSONUnicodeGuard(t *testing.T) {
	for _, raw := range []string{`{"text":"中文 😀 <&>"}`, `"\ud83d\ude00"`, `"\uD83D\uDE00"`, `"\\ud800"`, `{"\\":"escaped \\\" text","value":"\u0000"}`} {
		if err := CheckJSONUnicode([]byte(raw)); err != nil {
			t.Fatal(raw, err)
		}
	}
	for _, raw := range []string{`"\ud800"`, `"\udc00"`, `"\ud800\\udc00"`, `"\ud800\ud800"`, string([]byte{'"', 0xff, '"'})} {
		if err := CheckJSONUnicode([]byte(raw)); err == nil {
			t.Fatal("lossy JSON accepted", raw)
		}
	}
}

func TestLossyLegacyJSONIsPreservedAndCannotBeMutated(t *testing.T) {
	directory := t.TempDir()
	store := NewStore(directory)
	state := must(t)(store.Create(fixture(t), "", Object{}))
	id := str(state["id"])
	path := filepath.Join(directory, id+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw = bytes.Replace(raw, []byte(`"title":`), []byte(`"unused":"\ud800","title":`), 1)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	reader := NewStore(directory)
	if _, err := reader.Get(id, ""); err == nil || !strings.Contains(err.Error(), "UTF-16 surrogate") {
		t.Fatal(err)
	}
	if _, err := reader.Mutate(id, add(state, "new-opinion"), ""); err == nil {
		t.Fatal("mutated a lossy legacy file")
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(raw, after) {
		t.Fatal("legacy bytes changed", err)
	}
}
