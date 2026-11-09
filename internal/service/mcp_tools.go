package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"strconv"
	"unicode/utf16"

	"logicmargin/internal/agent"
	"logicmargin/internal/review"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type toolField struct {
	name, kind, flag string
	optional         bool
}

type reviewTool struct {
	name, command, description        string
	fields                            []toolField
	readOnly, idempotent, destructive bool
}

var reviewTools = []reviewTool{
	{name: "start_review", command: "start", description: "核验本机源码并创建独立评审，立即返回会话 ID 与网页地址。随后用 wait_review 等待人工提交；不要反复调用 get_review 检查。", fields: []toolField{
		{"review_file", "path", "", false}, {"source_root", "path", "--source-root", false}, {"purpose", "text", "--purpose", false},
		{"baseline_file", "path", "--baseline-file", true}, {"baseline_source_root", "path", "--baseline-source-root", true}, {"baseline_review", "boolean", "--baseline-review", true},
		{"context", "context", "--context", true}, {"public_url", "string", "--public-url", true}, {"cleanup_on_approval", "boolean", "--cleanup-on-approval", true},
	}},
	{name: "verify_review", command: "verify", description: "只读核验评审文件与本机源码的文件、片段摘要和快照指纹。", readOnly: true, idempotent: true, fields: []toolField{
		{"review_file", "path", "", false}, {"source_root", "path", "--source-root", false}, {"baseline_file", "path", "--baseline-file", true}, {"baseline_source_root", "path", "--baseline-source-root", true},
	}},
	{name: "attach_review_baseline", command: "baseline", description: "为缺少固定基线的原评审补入修改前流程图，先核验修改前源码，沿用 session ID 与评审轮次。已存在的基线保持固定。", idempotent: true, fields: []toolField{
		{"session_id", "identifier", "", false}, {"baseline_file", "path", "", false}, {"source_root", "path", "--source-root", false},
	}},
	{name: "get_review", command: "get", description: "读取完整评审、固定提交和历史快照；可读取已归档任务。等待人工意见请使用 wait_review。", readOnly: true, idempotent: true, fields: []toolField{{"session_id", "identifier", "", false}}},
	{name: "list_reviews", command: "list", description: "按 Agent 上下文和活动或归档状态查找已有评审；连接恢复后先定位原会话，避免重复创建。", readOnly: true, idempotent: true, fields: []toolField{
		{"context", "context", "--context", true}, {"state", "state", "--state", true},
	}},
	{name: "wait_review", command: "wait", description: "在工具内部持续等待“提交本轮”或“确认通过”，保存单条批注不会返回。after_submission 使用最后实际处理的提交 ID。返回后另用 acknowledge_review 领取反馈；通过后按清理策略调用 cleanup_review。取消或断线不会领取或归档。", readOnly: true, idempotent: true, fields: []toolField{
		{"session_id", "identifier", "", false}, {"after_submission", "identifier", "--after", true}, {"timeout_seconds", "positive", "--timeout", true},
	}},
	{name: "acknowledge_review", command: "ack", description: "在 Agent 实际读到固定反馈后标记领取。不要在 wait_review 返回之前领取；只接受当前轮最新反馈。", idempotent: true, fields: []toolField{
		{"session_id", "identifier", "", false}, {"submission_id", "identifier", "", false},
	}},
	{name: "reply_review", command: "reply", description: "向原批注添加临时 Agent 回复；回复不会替人确认解决。最终回应可与 revise_review 一起发布。", fields: []toolField{
		{"session_id", "identifier", "", false}, {"comment_id", "identifier", "", false}, {"body", "text", "--body", false},
	}},
	{name: "revise_review", command: "revise", description: "核验当前工作区源码，按 Agent 实际处理的 base_round 发布新版流程与最终回复。逻辑未变时必须填写 unchanged_reason。", fields: []toolField{
		{"session_id", "identifier", "", false}, {"review_file", "path", "", false}, {"source_root", "path", "--source-root", false},
		{"base_round", "round", "--base-round", false}, {"summary", "text", "--summary", false}, {"unchanged_reason", "text", "--unchanged-reason", true},
		{"replies_file", "path", "--replies-file", true}, {"public_url", "string", "--public-url", true},
	}},
	{name: "cleanup_review", command: "cleanup", description: "Agent 实际取得最终通过结果后归档评审（默认、可恢复）。永久删除或清理未完成评审须有明确用户授权。", destructive: true, fields: []toolField{
		{"session_id", "identifier", "", false}, {"mode", "mode", "--mode", true}, {"force", "boolean", "--force", true},
	}},
	{name: "restore_review", command: "restore", description: "从归档恢复同一评审，保留原会话 ID、批注和历史。", fields: []toolField{{"session_id", "identifier", "", false}}},
}

func fieldSchema(kind string) review.Object {
	switch kind {
	case "boolean":
		return review.Object{"type": "boolean"}
	case "positive":
		return review.Object{"type": "number", "exclusiveMinimum": 0}
	case "round":
		return review.Object{"type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991}
	case "state":
		return review.Object{"type": "string", "enum": []string{"active", "archived", "all"}}
	case "mode":
		return review.Object{"type": "string", "enum": []string{"archive", "delete"}}
	case "identifier":
		return review.Object{"type": "string", "minLength": 1, "maxLength": 200}
	case "text":
		return review.Object{"type": "string", "minLength": 1, "maxLength": 10000}
	case "context":
		return review.Object{"type": "string", "minLength": 1, "maxLength": 1000}
	case "path":
		return review.Object{"type": "string", "minLength": 1}
	default:
		return review.Object{"type": "string"}
	}
}

func (tool reviewTool) schema() review.Object {
	properties := review.Object{}
	required := []string{}
	for _, field := range tool.fields {
		properties[field.name] = fieldSchema(field.kind)
		if !field.optional {
			required = append(required, field.name)
		}
	}
	schema := review.Object{"type": "object", "properties": properties, "$schema": "http://json-schema.org/draft-07/schema#", "additionalProperties": false}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func (tool reviewTool) arguments(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var input review.Object
	if err := json.Unmarshal(raw, &input); err != nil || input == nil {
		return nil, fmt.Errorf("工具参数必须是对象")
	}
	allowed := map[string]bool{}
	args := []string{tool.command}
	for _, field := range tool.fields {
		allowed[field.name] = true
		value, exists := input[field.name]
		if !exists {
			if field.optional {
				continue
			}
			return nil, fmt.Errorf("缺少工具参数：%s", field.name)
		}
		var argument string
		switch field.kind {
		case "boolean":
			boolean, ok := value.(bool)
			if !ok {
				return nil, fmt.Errorf("工具参数 %s 需要布尔值", field.name)
			}
			if boolean {
				args = append(args, field.flag)
			}
			continue
		case "positive", "round":
			number, ok := value.(float64)
			if !ok || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 || (field.kind == "round" && !safePositiveInteger(number)) {
				return nil, fmt.Errorf("工具参数 %s 需要正数", field.name)
			}
			argument = strconv.FormatFloat(number, 'f', -1, 64)
		default:
			var ok bool
			argument, ok = value.(string)
			if !ok {
				return nil, fmt.Errorf("工具参数 %s 需要字符串", field.name)
			}
			if field.kind == "path" && !filepath.IsAbs(argument) {
				return nil, fmt.Errorf("文件和来源工作区必须使用本机绝对路径")
			}
			if field.kind == "identifier" || field.kind == "text" || field.kind == "context" {
				maximum := map[string]int{"identifier": 200, "text": 10000, "context": 1000}[field.kind]
				if trimJS(argument) == "" || len(utf16.Encode([]rune(argument))) > maximum {
					return nil, fmt.Errorf("工具参数 %s 为空或超过长度上限", field.name)
				}
			}
			if field.kind == "state" && argument != "active" && argument != "archived" && argument != "all" || field.kind == "mode" && argument != "archive" && argument != "delete" {
				return nil, fmt.Errorf("工具参数 %s 无效", field.name)
			}
		}
		if field.flag != "" {
			args = append(args, field.flag)
		}
		args = append(args, argument)
	}
	for key := range input {
		if !allowed[key] {
			return nil, fmt.Errorf("不支持的工具参数：%s", key)
		}
	}
	return args, nil
}

func registerReviewTools(server *mcp.Server, serverURL string) {
	for _, tool := range reviewTools {
		server.AddTool(&mcp.Tool{Name: tool.name, Description: tool.description, InputSchema: tool.schema(), Annotations: &mcp.ToolAnnotations{
			ReadOnlyHint: tool.readOnly, IdempotentHint: tool.idempotent, DestructiveHint: &tool.destructive, OpenWorldHint: new(bool),
		}}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args, err := tool.arguments(request.Params.Arguments)
			if err != nil {
				return toolError(err.Error()), nil
			}
			var stdout bytes.Buffer
			if err = ctx.Err(); err == nil {
				err = agent.Run(ctx, append(args, "--url", serverURL), &stdout, io.Discard, agent.Options{URL: serverURL, ConsumeSubmission: false})
			}
			text := trimJS(stdout.String())
			if err != nil {
				if text != "" && json.Valid(stdout.Bytes()) {
					return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}, &mcp.TextContent{Text: "操作后续失败，以上结果仍然有效：" + err.Error()}}}, nil
				}
				return toolError(err.Error()), nil
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil
		})
	}
}
