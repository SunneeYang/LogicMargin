package review

import (
	"fmt"
	"strings"
	"testing"
)

func TestResolvedCommentSurvivesUnrelatedPublication(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(Object, int)
	}{
		{"new-round", func(Object, int) {}},
		{"new-revision", func(r Object, round int) { r["revision"] = fmt.Sprintf("v%d", round) }},
		{"unrelated-source", func(r Object, round int) {
			snapshot := obj(r["snapshot"], "")
			files := []Object{objects(snapshot["files"])[0], {"path": "other.go", "sha256": hash(fmt.Sprintf("other%d\n", round))}}
			snapshot["files"] = files
			snapshot["fingerprint"] = hash(manifestJSON(files))
		}},
		{"unrelated-node", func(r Object, round int) { objects(r["nodes"])[1]["detail"] = fmt.Sprintf("other rule %d", round) }},
		{"shifted-source-lines", func(r Object, round int) {
			evidence := objects(objects(r["nodes"])[0]["evidence"])[0]
			evidence["startLine"], evidence["endLine"] = float64(round), float64(round)
			files := []Object{{"path": "logic.go", "sha256": hash(strings.Repeat("\n", round-1) + str(evidence["code"]) + "\n")}}
			snapshot := obj(r["snapshot"], "")
			snapshot["files"], snapshot["fingerprint"] = files, hash(manifestJSON(files))
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			store := NewStore(t.TempDir())
			defer store.Close()
			get := must(t)
			state := get(store.Create(sourceReview(t, "v1", "chargeAfterSuccess()"), "", nil))
			id := str(state["id"])
			state = get(store.Mutate(id, add(state, "confirmed"), ""))
			state = get(store.Mutate(id, status(state, "confirmed", "resolved"), ""))
			confirmed := clone(objects(obj(state["review"], "")["comments"])[0]).(Object)
			for round := 2; round <= 3; round++ {
				next := clone(obj(state["review"], "")).(Object)
				next["comments"] = []any{}
				scenario.change(next, round)
				state = get(store.Revise(id, publish(state, next), ""))
				for _, view := range []string{"", "current"} {
					saved := get(store.Get(id, view))
					comment := objects(obj(saved["review"], "")["comments"])[0]
					if comment["status"] != "resolved" {
						t.Fatalf("round %d view %q reopened a confirmed comment after %s: %s", round, view, scenario.name, stringify(comment))
					}
					assertEqual(t, comment, confirmed)
				}
			}
			approved := get(store.Finish(id, Object{"kind": "approval", "expectedVersion": state["version"]}, ""))
			if approved["phase"] != "approved" {
				t.Fatal("unchanged resolved comment prevented human approval")
			}
		})
	}
}

func TestResolvedCommentRequiresReviewForRelatedChanges(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(Object)
	}{
		{"node-rule", func(r Object) { objects(r["nodes"])[0]["detail"] = "changed rule" }},
		{"node-source", func(r Object) {
			evidence := objects(objects(r["nodes"])[0]["evidence"])[0]
			evidence["code"], evidence["digest"] = "changedCharge()", hash("changedCharge()")
			files := []Object{{"path": "logic.go", "sha256": hash("changedCharge()\n")}}
			snapshot := obj(r["snapshot"], "")
			snapshot["files"], snapshot["fingerprint"] = files, hash(manifestJSON(files))
		}},
		{"removed-target", func(r Object) { r["nodes"], r["edges"] = []any{objects(r["nodes"])[1]}, []any{} }},
		{"agent-reply", func(r Object) {
			objects(r["comments"])[0]["replies"] = []any{Object{"id": "new-reply", "author": "agent", "body": "new response", "createdAt": "2026-11-11T00:00:00Z", "revision": "v2"}}
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			store := NewStore(t.TempDir())
			defer store.Close()
			get := must(t)
			state := get(store.Create(sourceReview(t, "v1", "chargeAfterSuccess()"), "", nil))
			id := str(state["id"])
			state = get(store.Mutate(id, add(state, "confirmed"), ""))
			state = get(store.Mutate(id, status(state, "confirmed", "resolved"), ""))
			next := clone(obj(state["review"], "")).(Object)
			next["revision"] = "v2"
			scenario.change(next)
			state = get(store.Revise(id, publish(state, next), ""))
			comment := objects(obj(state["review"], "")["comments"])[0]
			if comment["status"] != "needs-review" || comment["reviewedRevision"] != "v1" || num(comment["reviewedRound"]) != 1 {
				t.Fatalf("related change did not preserve the original confirmation and require review: %s", stringify(comment))
			}
			_, err := store.Finish(id, Object{"kind": "approval", "expectedVersion": state["version"]}, "")
			if err == nil {
				t.Fatal("related change bypassed human re-review")
			}
		})
	}
}
