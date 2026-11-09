package review

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var isoDatePattern = regexp.MustCompile(`^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$`)
var numericDatePattern = regexp.MustCompile(`^[0-9]+$`)
var legacyDatePattern = regexp.MustCompile(`^([0-9]{4,6})[-/]([0-9]{1,2})[-/]([0-9]{1,2})$`)
var isoTimestampPattern = regexp.MustCompile(`^[ \t]*(?:[0-9]{4}|[+-][0-9]{6})-.*T`)

func datePart(v string, defaultValue int) int {
	if v == "" {
		return defaultValue
	}
	n, _ := strconv.Atoi(v)
	return n
}
func clippedDate(t time.Time) (time.Time, bool) {
	return t, t.UnixMilli() >= -8640000000000000 && t.UnixMilli() <= 8640000000000000
}
func dateTime(s string) (time.Time, bool) {
	if m := isoDatePattern.FindStringSubmatch(strings.ToUpper(s)); m != nil {
		year := datePart(m[1], 0)
		month, day := datePart(m[2], 1), datePart(m[3], 1)
		hour, minute, second := datePart(m[4], 0), datePart(m[5], 0), datePart(m[6], 0)
		fraction := m[7] + "000"
		millisecond := datePart(fraction[:3], 0)
		if m[1] == "-000000" || month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 || hour > 24 || (hour == 24 && (minute != 0 || second != 0 || strings.Trim(m[7], "0") != "")) || (m[4] != "" && (m[2] == "" || m[3] == "")) {
			return time.Time{}, false
		}
		location := time.UTC
		zone := m[8]
		if m[4] != "" && zone == "" {
			location = time.Local
		} else if zone != "" && zone != "Z" {
			offset := strings.ReplaceAll(zone[1:], ":", "")
			h, min := datePart(offset[:2], 0), datePart(offset[2:], 0)
			if h > 23 || min > 59 {
				return time.Time{}, false
			}
			seconds := (h*60 + min) * 60
			if zone[0] == '-' {
				seconds = -seconds
			}
			location = time.FixedZone("", seconds)
		}
		return clippedDate(time.Date(year, time.Month(month), day, hour, minute, second, millisecond*1000000, location))
	}
	// shortcut: uncommon legacy Date.parse formats need Node vectors before extending this fallback.
	if isoTimestampPattern.MatchString(s) {
		return time.Time{}, false
	}
	s = trim(s)
	if numericDatePattern.MatchString(s) {
		n, e := strconv.Atoi(s)
		if e != nil || n > 275760 {
			return time.Time{}, false
		}
		year, month := n, 1
		switch {
		case n == 0:
			year = 2000
		case n <= 12:
			year = 2001
			month = n
		case n < 32:
			return time.Time{}, false
		case n < 50:
			year = 2000 + n
		case n < 100:
			year = 1900 + n
		}
		return clippedDate(time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.Local))
	}
	if m := legacyDatePattern.FindStringSubmatch(s); m != nil {
		y, mo, d := datePart(m[1], 0), datePart(m[2], 1), datePart(m[3], 1)
		if mo < 1 || mo > 12 || d < 1 || d > 31 {
			return time.Time{}, false
		}
		return clippedDate(time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.Local))
	}
	if i := strings.Index(s, " ("); i >= 0 && strings.HasSuffix(s, ")") {
		s = s[:i]
	}
	for _, layout := range []string{time.RFC1123, time.RFC1123Z, time.RFC822, time.RFC822Z, time.ANSIC, "Mon Jan 02 2006 15:04:05 GMT-0700", "Mon Jan 2 2006 15:04:05 GMT-0700", "January 2, 2006", "Jan 2, 2006", "1/2/2006", "2006-01-02 15:04:05.999999999Z07:00", "2006-01-02 15:04:05.999999999", "2006-01-02 15:04", "2006-01-02", "2006-01", "2006"} {
		if t, e := time.ParseInLocation(layout, s, time.Local); e == nil {
			return clippedDate(t)
		}
	}
	return time.Time{}, false
}
