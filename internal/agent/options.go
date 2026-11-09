package agent

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/big"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"logicmargin/internal/review"
)

const help = `LogicMargin agent review CLI

  start <review.json> [--wait]
  wait <sessionId> [--after <submissionId>] [--timeout <seconds>]
  comments <sessionId>
  get <sessionId>
  reply <sessionId> <commentId> --body-file <text-file>
  ack <sessionId> <submissionId>
  revise <sessionId> <review.json> --base-round <number> --summary <text> [--wait]
  verify <review.json> [--source-root <directory>]
  baseline <sessionId> <before.json> --source-root <baseline directory>
  resume <sessionId> [--wait]
  list [--context <thread/workflow>] [--state active|archived|all]
  cleanup <sessionId> [--mode archive|delete] [--force]
  restore <sessionId>

Options: --url <API base URL> (explicit remote service; otherwise auto-start locally)
         --public-url <review URL base> (for example a Tailscale address)
New review: --context <thread/workflow> --purpose <review purpose>
            --cleanup-on-approval (archive after the agent receives approval)
Waiting: --cleanup-on-approval also enables archival for this wait/resume call.
Sources: --source-root <directory> (verify/start/revise; default current working directory)
Baseline: --baseline-file <before.json> --baseline-source-root <baseline directory>
          (start/verify; an embedded baseline needs only --baseline-source-root)
          --baseline-review (start by reviewing the original system B before implementation)
Reply: --body <text> may replace --body-file.
Revision:
          --base-round <number> (round reviewed by the agent; obtain with wait/get)
          --unchanged-reason <text> (required when graph logic is unchanged)
          --replies-file <JSON file> (final replies published with the new graph)
Environment: LOGIC_MARGIN_URL and LOGIC_MARGIN_PUBLIC_URL supply URL defaults.

Only a browser submission completes wait. Replies never resolve comments.
JSON goes to stdout; review links and waiting status go to stderr.
`

// Options supplies the root command's selected service. Explicit flags and
// environment variables take priority. MCP leaves ConsumeSubmission false.
type Options struct {
	URL               string
	PublicURL         string
	ConsumeSubmission bool
	ResolveURL        func(context.Context) (string, error)
}

type cliOptions struct {
	values                                         map[string]string
	url, publicURL                                 string
	wait, baselineReview, cleanupOnApproval, force bool
	baseRound                                      float64
	timeout                                        time.Duration
	explicitURL, explicitPublicURL                 bool
}

func (o cliOptions) value(name string) string { return o.values["--"+name] }
func (o cliOptions) has(name string) bool     { _, ok := o.values["--"+name]; return ok }
func contains(s string, choices ...string) bool {
	for _, c := range choices {
		if s == c {
			return true
		}
	}
	return false
}

func baseURL(raw string) (string, error) {
	u, err := url.Parse(trim(raw))
	if err != nil || u == nil || !contains(strings.ToLower(u.Scheme), "http", "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") {
		return "", errors.New("URL 必须是无认证信息、查询参数或片段的 HTTP(S) 地址")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.Host = strings.ToLower(u.Host)
	if u.Scheme == "http" && u.Port() == "80" {
		u.Host = strings.TrimSuffix(u.Host, ":80")
	}
	if u.Scheme == "https" && u.Port() == "443" {
		u.Host = strings.TrimSuffix(u.Host, ":443")
	}
	if port := u.Port(); port != "" {
		p, err := strconv.Atoi(port)
		if err != nil || p < 0 || p > 65535 {
			return "", errors.New("URL 必须是无认证信息、查询参数或片段的 HTTP(S) 地址")
		}
	}
	if u.Path == "" {
		u.Path = "/"
	}
	return strings.TrimSuffix(u.String(), "/"), nil
}

var jsNumberPattern = regexp.MustCompile(`^(?:0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+|[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$`)

func jsNumber(s string) float64 {
	s = trim(s)
	if s == "" {
		return 0
	}
	if !jsNumberPattern.MatchString(s) {
		return math.NaN()
	}
	if len(s) > 2 && s[0] == '0' && contains(strings.ToLower(s[1:2]), "x", "o", "b") {
		integer, ok := new(big.Int).SetString(s, 0)
		if !ok {
			return math.NaN()
		}
		n, _ := new(big.Float).SetInt(integer).Float64()
		return n
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return math.NaN()
	}
	return n
}
func parseArgs(args []string, defaults Options) ([]string, cliOptions, bool, error) {
	o := cliOptions{values: map[string]string{}}
	positional := []string{}
	showHelp := false
	for i := 0; i < len(args); i++ {
		item := args[i]
		switch item {
		case "--help":
			showHelp = true
			continue
		case "--wait":
			o.wait = true
			continue
		case "--baseline-review":
			o.baselineReview = true
			continue
		case "--cleanup-on-approval":
			o.cleanupOnApproval = true
			continue
		case "--force":
			o.force = true
			continue
		}
		if !strings.HasPrefix(item, "-") {
			positional = append(positional, item)
			continue
		}
		if !contains(item, "--url", "--public-url", "--after", "--timeout", "--body-file", "--body", "--source-root", "--baseline-file", "--baseline-source-root", "--base-round", "--summary", "--unchanged-reason", "--replies-file", "--context", "--purpose", "--mode", "--state") {
			return nil, o, false, fmt.Errorf("未知参数 %s", item)
		}
		if _, ok := o.values[item]; ok {
			return nil, o, false, fmt.Errorf("重复参数 %s", item)
		}
		i++
		if i >= len(args) || args[i] == "" || item != "--body" && strings.HasPrefix(args[i], "--") {
			return nil, o, false, fmt.Errorf("%s 缺少值", item)
		}
		o.values[item] = args[i]
	}
	rawURL := defaults.URL
	if rawURL == "" {
		rawURL = "http://127.0.0.1:5173"
	}
	if v, ok := os.LookupEnv("LOGIC_MARGIN_URL"); ok {
		o.explicitURL = true
		rawURL = v
	}
	if o.has("url") {
		o.explicitURL = true
		rawURL = o.value("url")
	}
	var err error
	o.url, err = baseURL(rawURL)
	if err != nil {
		return nil, o, false, err
	}
	rawPublic := defaults.PublicURL
	if rawPublic == "" {
		rawPublic = o.url
	}
	if v, ok := os.LookupEnv("LOGIC_MARGIN_PUBLIC_URL"); ok {
		o.explicitPublicURL = true
		rawPublic = v
	}
	if o.has("public-url") {
		o.explicitPublicURL = true
		rawPublic = o.value("public-url")
	}
	o.publicURL, err = baseURL(rawPublic)
	if err != nil {
		return nil, o, false, err
	}
	if o.has("context") || o.has("purpose") {
		scope := object{"purpose": "评审"}
		if o.has("purpose") {
			scope["purpose"] = o.value("purpose")
		}
		if o.has("context") {
			scope["context"] = o.value("context")
		}
		checked, err := review.ParseSessionOptions(object{"scope": scope})
		if err != nil {
			return nil, o, false, err
		}
		if o.has("purpose") {
			o.values["--purpose"] = str(obj(checked["scope"])["purpose"])
		}
		if o.has("context") {
			o.values["--context"] = str(obj(checked["scope"])["context"])
		}
	}
	if o.has("mode") && !contains(o.value("mode"), "archive", "delete") {
		return nil, o, false, errors.New("--mode 必须是 archive 或 delete")
	}
	if o.has("state") && !contains(o.value("state"), "active", "archived", "all") {
		return nil, o, false, errors.New("--state 必须是 active、archived 或 all")
	}
	if o.has("base-round") {
		o.baseRound = jsNumber(o.value("base-round"))
		if !safeInteger(o.baseRound) || o.baseRound < 1 {
			return nil, o, false, errors.New("--base-round 必须是正整数")
		}
	}
	if o.has("timeout") {
		n := jsNumber(o.value("timeout"))
		if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 {
			return nil, o, false, errors.New("--timeout 必须是大于 0 的秒数")
		}
		o.timeout = time.Duration(math.Min(math.Ceil(n*float64(time.Second)), float64(math.MaxInt64-1024)))
	}
	return positional, o, showHelp, nil
}
func validateArgs(p []string, o cliOptions) error {
	command := ""
	if len(p) > 0 {
		command = p[0]
	}
	arity := 2
	if command == "list" {
		arity = 1
	}
	if contains(command, "reply", "revise", "ack", "baseline") {
		arity = 3
	}
	if !contains(command, "start", "wait", "comments", "get", "reply", "revise", "resume", "verify", "list", "cleanup", "restore", "ack", "baseline") || len(p) != arity {
		return errors.New("命令或参数数量无效；使用 --help 查看用法")
	}
	checks := []struct {
		bad     bool
		message string
	}{
		{(o.value("body-file") != "" || o.has("body")) && command != "reply", "--body-file 和 --body 仅用于 reply"},
		{o.value("body-file") != "" && o.has("body"), "--body-file 与 --body 不能同时使用"},
		{o.value("source-root") != "" && !contains(command, "start", "revise", "verify", "baseline"), "--source-root 仅用于 start、revise、verify 或 baseline"},
		{o.baselineReview && command != "start", "--baseline-review 仅用于 start"},
		{o.baselineReview && (o.has("baseline-file") || o.has("baseline-source-root")), "--baseline-review 使用输入的原版图和 --source-root，不能同时指定独立基线文件或目录"},
		{(o.has("baseline-file") || o.has("baseline-source-root")) && !contains(command, "start", "verify"), "--baseline-file 和 --baseline-source-root 仅用于 start 或 verify"},
		{o.has("baseline-file") && !o.has("baseline-source-root"), "--baseline-file 需要 --baseline-source-root 指向修改前源码目录"},
		{command == "baseline" && !o.has("source-root"), "baseline 需要 --source-root 指向修改前源码目录"},
		{o.has("base-round") && command != "revise", "--base-round 仅用于 revise"},
		{command == "revise" && !o.has("base-round"), "revise 需要 --base-round <agent 实际审阅的轮次>，请从 wait 或 get 获取"},
		{(o.has("summary") || o.has("unchanged-reason") || o.has("replies-file")) && command != "revise", "发布说明与最终回复参数仅用于 revise"},
		{command == "revise" && (trim(o.value("summary")) == "" || utf16Len(o.value("summary")) > 10000), "revise 需要 --summary <本轮实际变化说明>，最多 10000 字符"},
		{o.has("unchanged-reason") && (trim(o.value("unchanged-reason")) == "" || utf16Len(o.value("unchanged-reason")) > 10000), "流程未变的原因须为非空文本，最多 10000 字符"},
		{(o.has("after") || o.has("timeout")) && command != "wait" && !o.wait, "--after 和 --timeout 需要 wait 命令或 --wait"},
		{o.wait && !contains(command, "start", "revise", "resume", "wait"), "此命令不支持 --wait"},
		{o.has("context") && !contains(command, "start", "list"), "--context 仅用于 start 或 list"},
		{o.has("purpose") && command != "start", "--purpose 仅用于 start"},
		{o.has("state") && command != "list", "--state 仅用于 list"},
		{(o.has("mode") || o.force) && command != "cleanup", "--mode 和 --force 仅用于 cleanup"},
		{o.cleanupOnApproval && !contains(command, "start", "wait", "resume"), "--cleanup-on-approval 仅用于 start、wait 或 resume"},
		{o.cleanupOnApproval && command == "resume" && !o.wait, "resume 的 --cleanup-on-approval 需要 --wait"},
	}
	for _, c := range checks {
		if c.bad {
			return errors.New(c.message)
		}
	}
	return nil
}
