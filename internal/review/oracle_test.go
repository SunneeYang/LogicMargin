package review

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

type oracleFixture struct {
	Review      Object   `json:"review"`
	SourceFiles []Object `json:"sourceFiles"`
	Fingerprint string   `json:"fingerprint"`
	Vectors     []Object `json:"vectors"`
	Steps       []Object `json:"steps"`
}

func oracle(t *testing.T) oracleFixture {
	t.Helper()
	raw, e := os.ReadFile("testdata/oracle.json")
	if e != nil {
		t.Fatal(e)
	}
	var fixture oracleFixture
	if e = json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	return fixture
}
func assertEqual(t *testing.T, got, want any) {
	t.Helper()
	if !equal(got, want) {
		t.Fatalf("got %s\nwant %s", stringify(got), stringify(want))
	}
}
func assertError(t *testing.T, err error, message string, status int) {
	t.Helper()
	var se *Error
	if err == nil || !errors.As(err, &se) || se.Message != message || se.Status != status {
		t.Fatalf("error = %v; want %d %q", err, status, message)
	}
}
func TestNodeOracle(t *testing.T) {
	f := oracle(t)
	for _, v := range f.Vectors {
		t.Run(str(v["name"]), func(t *testing.T) {
			var got any
			var err error
			switch v["kind"] {
			case "review":
				got, err = ParseReview(v["input"])
			case "baseline":
				got, err = ParseBaseline(v["input"])
			case "files":
				got, err = ParseSourceFiles(v["input"])
			case "options":
				got, err = ParseSessionOptions(v["input"])
			case "evidence":
				err = ValidateEvidenceCode(obj(v["input"], ""))
				got = true
			case "identity":
				got = LogicIdentity(obj(v["input"], ""))
			case "publication":
				got, err = ValidatePublication(v["input"], obj(v["review"], ""))
			case "rebase":
				got, err = capture(func() Object { return rebaseReview(obj(v["before"], ""), obj(v["input"], "")) })
			case "current":
				got = currentSession(obj(v["input"], ""))
			default:
				t.Fatal(v["kind"])
			}
			if message, ok := v["error"].(string); ok {
				assertError(t, err, message, int(num(v["status"])))
			} else {
				if err != nil {
					t.Fatal(err)
				}
				assertEqual(t, got, v["output"])
			}
		})
	}
	if got := hash(manifestJSON(f.SourceFiles)); got != f.Fingerprint {
		t.Fatalf("source fingerprint %s != %s", got, f.Fingerprint)
	}
}
func normalizeGenerated(v Object) Object {
	v = clone(v).(Object)
	if num(v["schemaVersion"]) == 1 && present(v, "phase") {
		v["id"] = "<session>"
		v["createdAt"] = "<created>"
		v["updatedAt"] = "<updated>"
		for _, r := range objects(v["history"]) {
			r["createdAt"] = "<record>"
		}
		for _, sn := range objects(v["snapshots"]) {
			sn["openedAt"] = "<opened>"
		}
	}
	if present(v, "openedAt") && present(v, "review") {
		v["openedAt"] = "<opened>"
	}
	if str(v["kind"]) == "logic-margin-feedback" || str(v["kind"]) == "logic-margin-approval" {
		v["createdAt"] = "<record>"
	}
	if present(v, "archivedAt") {
		v["archivedAt"] = "<archive>"
	}
	return v
}
func TestNodeLifecycleOracle(t *testing.T) {
	f := oracle(t)
	s := NewStore(t.TempDir())
	defer s.Close()
	id := ""
	for i, step := range f.Steps {
		op := str(step["op"])
		input := obj(step["input"], "")
		view := str(step["view"])
		var got Object
		var err error
		switch op {
		case "create":
			got, err = s.Create(input["review"], view, obj(input["options"], ""))
			if err == nil {
				id = str(got["id"])
			}
		case "get":
			got, err = s.Get(id, view)
		case "mutate":
			got, err = s.Mutate(id, input, view)
		case "finish":
			got, err = s.Finish(id, input, view)
		case "acknowledge":
			got, err = s.Acknowledge(id, input, view)
		case "revise":
			got, err = s.Revise(id, input, view)
		case "getSnapshot":
			got, err = s.GetSnapshot(id, int(num(input["round"])))
		case "getRecord":
			got, err = s.GetRecord(id, str(input["record"]))
		case "cleanup":
			got, err = s.Cleanup(id, input)
		case "restore":
			got, err = s.Restore(id, input)
		case "getArchive":
			got, err = s.GetArchive(id)
		default:
			t.Fatalf("step %d: unknown operation %s", i, op)
		}
		if message, ok := step["error"].(string); ok {
			t.Run(op, func(t *testing.T) { assertError(t, err, message, int(num(step["status"]))) })
			continue
		}
		if err != nil {
			t.Fatalf("step %d %s: %v", i, op, err)
		}
		got = normalizeGenerated(got)
		if got["id"] == id {
			got["id"] = "<session>"
		}
		t.Run(op, func(t *testing.T) { assertEqual(t, got, step["output"]) })
	}
}
