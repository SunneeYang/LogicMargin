package review

import (
	"errors"
	"strconv"
	"unicode/utf8"
)

// Reject text that encoding/json would silently replace before it reaches saved history.
func CheckJSONUnicode(raw []byte) error {
	if !utf8.Valid(raw) {
		return errors.New("JSON 必须是有效 UTF-8 文本")
	}
	inside := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inside = !inside
			continue
		}
		if !inside || raw[i] != '\\' || i+1 >= len(raw) {
			continue
		}
		if raw[i+1] != 'u' {
			i++
			continue
		}
		if i+6 > len(raw) {
			return nil
		}
		unit, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
		if err != nil {
			return nil
		}
		if unit >= 0xd800 && unit <= 0xdbff {
			if i+12 <= len(raw) && raw[i+6] == '\\' && raw[i+7] == 'u' {
				low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
				if err == nil && low >= 0xdc00 && low <= 0xdfff {
					i += 11
					continue
				}
			}
			return errors.New("JSON 含无法无损保留的孤立 UTF-16 surrogate，请修复原文件后重试")
		}
		if unit >= 0xdc00 && unit <= 0xdfff {
			return errors.New("JSON 含无法无损保留的孤立 UTF-16 surrogate，请修复原文件后重试")
		}
		i += 5
	}
	return nil
}
