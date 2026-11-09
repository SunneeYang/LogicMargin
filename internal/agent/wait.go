package agent

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"time"
)

func compactSubmission(current, submission object) object {
	history := arr(current["history"])
	submissionIndex := historyIndex(history, submission["id"])
	round := current["round"]
	snapshots := arr(current["snapshots"])
	for i := len(snapshots) - 1; i >= 0; i-- {
		snapshot := obj(snapshots[i])
		if submissionIndex > historyIndex(history, snapshot["afterSubmission"]) {
			round = snapshot["round"]
			break
		}
	}
	approved := submission["kind"] == "logic-margin-approval"
	doc := obj(submission["review"])
	source := obj(doc["snapshot"])
	summary := object{"id": doc["id"], "title": doc["title"], "revision": doc["revision"]}
	if approved {
		snapshot := object{}
		for _, k := range []string{"repository", "commit", "fingerprint", "capturedAt", "dirty"} {
			snapshot[k] = source[k]
		}
		summary["snapshot"] = snapshot
		summary["resolvedCommentCount"] = len(arr(doc["comments"]))
	} else {
		summary["snapshot"] = source
		summary["comments"] = doc["comments"]
	}
	result := object{"sessionId": current["id"], "round": round, "approved": approved, "submission": object{"id": submission["id"], "kind": submission["kind"], "createdAt": submission["createdAt"], "review": summary}}
	for _, k := range []string{"scope", "cleanupPolicy", "baselineReview"} {
		if v, ok := current[k]; ok {
			result[k] = v
		}
	}
	return result
}

var waitTimeoutError = errors.New("等待审查超时；会话和批注已保留，可用 resume 继续")

func waitForSubmission(c client, current object, o cliOptions, out, errOut io.Writer, consume bool) error {
	var deadline time.Time
	if o.has("timeout") {
		deadline = time.Now().Add(o.timeout)
	}
	if _, err := fmt.Fprintf(errOut, "等待本轮提交：%s\n", reviewLink(o.publicURL, str(current["id"]))); err != nil {
		return err
	}
	for {
		if err := c.ctx.Err(); err != nil {
			return err
		}
		history := arr(current["history"])
		snapshots := arr(current["snapshots"])
		var boundary any
		if len(snapshots) > 0 {
			boundary = obj(snapshots[len(snapshots)-1])["afterSubmission"]
		}
		after := current["acknowledgedSubmission"]
		if historyIndex(history, boundary) > historyIndex(history, after) {
			after = boundary
		}
		if o.has("after") {
			after = o.value("after")
		}
		cursor := historyIndex(history, after)
		if after != nil && cursor < 0 {
			return fmt.Errorf("找不到提交游标 %s；请用 get 核对会话历史", str(after))
		}
		unread := history[cursor+1:]
		if len(unread) > 0 {
			submission := obj(unread[len(unread)-1])
			feedback := submission["kind"] == "logic-margin-feedback"
			if feedback && consume {
				if _, err := c.required("/"+encodeURIComponent(str(current["id"]))+"/ack", object{"submissionId": submission["id"]}); err != nil {
					return err
				}
			}
			result := compactSubmission(current, submission)
			approved := result["approved"] == true
			autoCleanup := o.cleanupOnApproval || current["cleanupPolicy"] == "archive-on-approval"
			if !consume && feedback {
				result["requiresAcknowledgement"] = true
			}
			if !consume && approved && autoCleanup {
				result["cleanupPending"] = true
			}
			if len(unread) > 1 {
				earlier := make([]any, 0, len(unread)-1)
				for _, v := range unread[:len(unread)-1] {
					if approved {
						earlier = append(earlier, obj(v)["id"])
					} else {
						earlier = append(earlier, compactSubmission(current, obj(v)))
					}
				}
				if approved {
					result["earlierSubmissionIds"] = earlier
				} else {
					result["earlierSubmissions"] = earlier
				}
			}
			if err := writeJSON(out, result); err != nil {
				return err
			}
			if consume && approved && autoCleanup {
				doc, currentDoc := obj(submission["review"]), obj(current["review"])
				if current["phase"] != "approved" || result["round"] != current["round"] || doc["revision"] != currentDoc["revision"] || obj(doc["snapshot"])["fingerprint"] != obj(currentDoc["snapshot"])["fingerprint"] {
					_, err := fmt.Fprintln(errOut, "通过记录不属于当前已通过轮次，保留会话并跳过自动归档。")
					return err
				}
				if _, err := c.cleanup(current, "archive", false); err != nil {
					return fmt.Errorf("已输出通过结果，但自动归档失败；会话数据已保留：%w", err)
				}
				_, err := fmt.Fprintf(errOut, "评审已归档，可用 restore %s 恢复。\n", str(current["id"]))
				return err
			}
			return nil
		}
		remaining := time.Duration(math.MaxInt64)
		if !deadline.IsZero() {
			remaining = time.Until(deadline)
			if remaining <= 0 {
				return waitTimeoutError
			}
		}
		poll := min(25*time.Second, remaining)
		timeout := min(30*time.Second, remaining)
		path := fmt.Sprintf("/%s?afterVersion=%.0f&waitMs=%d", encodeURIComponent(str(current["id"])), number(current["version"]), int64(math.Ceil(float64(poll)/float64(time.Millisecond))))
		updated, err := c.request(path, nil, timeout)
		if err != nil {
			if parentErr := c.ctx.Err(); parentErr != nil {
				return parentErr
			}
			if !deadline.IsZero() && (time.Now().After(deadline) || remaining <= 30*time.Second && errors.Is(err, context.DeadlineExceeded)) {
				return waitTimeoutError
			}
			return err
		}
		if updated != nil {
			current = updated
		}
	}
}
