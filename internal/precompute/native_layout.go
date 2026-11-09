package precompute

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf8"
)

// computeNativeLayout mirrors graph-routing.ts and the authored branch of
// graph-focus.ts. The caller validates input and retains Dagre in the VM.
func computeNativeLayout(ctx context.Context, input LayoutInput) (LayoutResult, bool, error) {
	if err := ctx.Err(); err != nil {
		return LayoutResult{}, true, err
	}
	sizes := make(map[string]Size, len(input.Sizes))
	for _, size := range input.Sizes {
		sizes[size.ID] = size
	}
	visibleSizes := sizes
	nodes, edges := input.Nodes, input.Edges
	var routeIDs map[string]string
	if input.Reference != nil {
		combined := make(map[string]PlanNode)
		joint := make(map[string]Size)
		for _, side := range [][]PlanNode{nodes, input.Reference.Nodes} {
			for _, node := range side {
				if err := ctx.Err(); err != nil {
					return LayoutResult{}, true, err
				}
				prior, exists := combined[node.ID]
				if !exists || nativeCompareIDs(node.Kind, prior.Kind) < 0 || node.Kind == prior.Kind &&
					(node.Position.Y < prior.Position.Y || node.Position.Y == prior.Position.Y && node.Position.X < prior.Position.X) {
					combined[node.ID] = node
				}
				measured, priorSize := sizes[node.ID], joint[node.ID]
				joint[node.ID] = Size{ID: node.ID, Width: math.Max(248, math.Max(measured.Width, priorSize.Width)),
					Height: math.Max(nativeEstimatedHeight(node), math.Max(measured.Height, priorSize.Height))}
			}
		}
		nodes = make([]PlanNode, 0, len(combined))
		for _, node := range combined {
			nodes = append(nodes, node)
		}
		sort.SliceStable(nodes, func(i, j int) bool { return nativeCompareIDs(nodes[i].ID, nodes[j].ID) < 0 })
		combinedEdges := make(map[string]PlanEdge)
		for _, side := range [][]PlanEdge{edges, input.Reference.Edges} {
			for _, edge := range side {
				if err := ctx.Err(); err != nil {
					return LayoutResult{}, true, err
				}
				key := nativeEdgeIdentity(edge)
				prior, exists := combinedEdges[key]
				length, priorLength := nativeUTF16Length(edge.Label), nativeUTF16Length(prior.Label)
				if !exists || length > priorLength || length == priorLength && nativeCompareIDs(edge.Label, prior.Label) < 0 {
					combinedEdges[key] = edge
				}
			}
		}
		keys := make([]string, 0, len(combinedEdges))
		for key := range combinedEdges {
			keys = append(keys, key)
		}
		sort.SliceStable(keys, func(i, j int) bool { return nativeCompareIDs(keys[i], keys[j]) < 0 })
		edges = make([]PlanEdge, 0, len(keys))
		routeIDs = make(map[string]string, len(keys))
		for _, key := range keys {
			edge := combinedEdges[key]
			edge.ID = "comparison:" + nativeURIComponent(key)
			routeIDs[key] = edge.ID
			edges = append(edges, edge)
		}
		sizes = joint
	}
	placed, handled, err := nativeAlignedComparisonPositions(ctx, input, nodes, edges, sizes)
	if err == nil && !handled {
		placed, handled, err = nativeAuthoredPositions(ctx, nodes, edges, sizes)
	}
	if err != nil || !handled {
		return LayoutResult{}, handled, err
	}
	usesAuthored := len(nodes) >= 2
	if input.Reference != nil {
		visible := make([]nativeNode, 0, len(input.Nodes))
		byID := make(map[string]int, len(placed))
		for i := range placed {
			byID[placed[i].id] = i
		}
		for _, node := range input.Nodes {
			size, ok := visibleSizes[node.ID]
			if !ok {
				size = Size{Width: 248, Height: 160}
			}
			visible = append(visible, nativeNode{id: node.ID, kind: node.Kind, LayoutNode: LayoutNode{
				Position: placed[byID[node.ID]].Position, Width: size.Width, Height: size.Height}})
		}
		placed = visible
		edges = make([]PlanEdge, len(input.Edges))
		for i, edge := range input.Edges {
			edge.ID = routeIDs[nativeEdgeIdentity(edge)]
			edges[i] = edge
		}
	}
	routes, err := nativeRouteGraphEdges(ctx, placed, edges)
	if err != nil {
		return LayoutResult{}, true, err
	}
	result := LayoutResult{Nodes: make(map[string]LayoutNode, len(placed)), Edges: routes, UsesAuthoredPositions: usesAuthored}
	for _, node := range placed {
		node.Ports = make([]Port, len(node.ports))
		for i := range node.ports {
			node.Ports[i] = node.ports[i].Port
		}
		result.Nodes[node.id] = node.LayoutNode
	}
	if input.Reference != nil {
		result.Edges = make(map[string]LayoutEdge, len(input.Edges))
		for _, edge := range input.Edges {
			result.Edges[edge.ID] = routes[routeIDs[nativeEdgeIdentity(edge)]]
		}
	}
	return result, true, ctx.Err()
}

type nativeNode struct {
	id, kind string
	LayoutNode
	ports []nativePort
}
type nativePort struct {
	Port
	partner int
	gutter  float64
}
type nativeBox struct{ x, y, width, height float64 }
type nativeSegment struct{ a, b Point }
type nativeLabel struct{ width, height float64 }

func nativeIntersects(a, b nativeBox, gap float64) bool {
	return a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y
}
func nativeCrosses(a, b Point, obstacle nativeBox, padding float64) bool {
	left, right := obstacle.x-padding, obstacle.x+obstacle.width+padding
	top, bottom := obstacle.y-padding, obstacle.y+obstacle.height+padding
	if a.X == b.X {
		return a.X > left && a.X < right && math.Max(a.Y, b.Y) > top && math.Min(a.Y, b.Y) < bottom
	}
	return a.Y > top && a.Y < bottom && math.Max(a.X, b.X) > left && math.Min(a.X, b.X) < right
}
func nativeLabelBox(p Point, label nativeLabel) nativeBox {
	return nativeBox{p.X - label.width/2, p.Y - label.height/2, label.width, label.height}
}
func nativeMeasureLabel(text string) nativeLabel {
	width, widest, lines := 0, 0, 1
	for _, character := range text {
		if character == '\n' {
			widest = max(widest, width)
			width = 0
			lines++
			continue
		}
		advance := 7
		if character > 255 {
			advance = 12
		}
		if width != 0 && width+advance > 180 {
			widest = max(widest, width)
			width = 0
			lines++
		}
		width += advance
	}
	return nativeLabel{float64(max(widest, width) + 12), float64(lines*16 + 8)}
}
func nativeEstimatedHeight(node PlanNode) float64 {
	lines := func(value string, width int) int {
		n := 0
		for _, line := range strings.Split(value, "\n") {
			n += max(1, (utf8.RuneCountInString(line)+width-1)/width)
		}
		return n
	}
	height := 90 + lines(node.Title, 14)*23
	if node.Summary != "" {
		height += 8 + lines(node.Summary, 17)*20
	}
	return float64(max(160, height))
}
func nativeUTF16Length(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xffff {
			n++
		}
	}
	return n
}

// UTF-8 byte order differs from JavaScript's UTF-16 order above U+FFFF.
func nativeCompareIDs(a, b string) int {
	next := func(s string, at *int, pending *uint16) uint16 {
		if *pending != 0 {
			unit := *pending
			*pending = 0
			return unit
		}
		r, width := utf8.DecodeRuneInString(s[*at:])
		*at += width
		if r <= 0xffff {
			return uint16(r)
		}
		r -= 0x10000
		*pending = uint16(0xdc00 + (r & 1023))
		return uint16(0xd800 + (r >> 10))
	}
	i, j := 0, 0
	var pa, pb uint16
	for (i < len(a) || pa != 0) && (j < len(b) || pb != 0) {
		x, y := next(a, &i, &pa), next(b, &j, &pb)
		if x < y {
			return -1
		}
		if x > y {
			return 1
		}
	}
	if i < len(a) || pa != 0 {
		return 1
	}
	if j < len(b) || pb != 0 {
		return -1
	}
	return 0
}
func nativeEdgeIdentity(edge PlanEdge) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, s := range []string{edge.ID, edge.Source, edge.Target} {
		if i > 0 {
			b.WriteByte(',')
		}
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
					const hex = "0123456789abcdef"
					b.WriteString(`\u00`)
					b.WriteByte(hex[r>>4])
					b.WriteByte(hex[r&15])
				} else {
					b.WriteRune(r)
				}
			}
		}
		b.WriteByte('"')
	}
	b.WriteByte(']')
	return b.String()
}
func nativeURIComponent(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("-_.!~*'()", rune(c)) {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&15])
		}
	}
	return b.String()
}

func nativeAuthoredPositions(ctx context.Context, nodes []PlanNode, edges []PlanEdge, sizes map[string]Size) ([]nativeNode, bool, error) {
	if len(nodes) == 0 && len(edges) == 0 {
		return []nativeNode{}, true, nil
	}
	if len(nodes) < 2 {
		return nil, false, nil
	}
	byID := make(map[string]bool, len(nodes))
	for i, node := range nodes {
		if err := ctx.Err(); err != nil {
			return nil, true, err
		}
		if math.IsNaN(node.Position.X) || math.IsNaN(node.Position.Y) || math.IsInf(node.Position.X, 0) || math.IsInf(node.Position.Y, 0) {
			return nil, false, nil
		}
		for _, other := range nodes[i+1:] {
			if nativeIntersects(nativeBox{node.Position.X, node.Position.Y, 248, 160}, nativeBox{other.Position.X, other.Position.Y, 248, 160}, 0) {
				return nil, false, nil
			}
		}
		byID[node.ID] = true
	}
	for _, edge := range edges {
		if !byID[edge.Source] || !byID[edge.Target] {
			return nil, true, fmt.Errorf("连线 %s 引用了不存在的节点", edge.ID)
		}
	}
	return nativeGridPositions(ctx, nodes, edges, sizes)
}

func nativeAlignedComparisonPositions(ctx context.Context, input LayoutInput, nodes []PlanNode, edges []PlanEdge, sizes map[string]Size) ([]nativeNode, bool, error) {
	if input.Reference == nil || len(input.Nodes) < 2 || len(input.Reference.Nodes) < 2 {
		return nil, false, nil
	}
	current, reference := make(map[string]PlanNode), make(map[string]PlanNode)
	for _, node := range input.Nodes {
		current[node.ID] = node
	}
	for _, node := range input.Reference.Nodes {
		reference[node.ID] = node
	}
	var shared PlanNode
	found := false
	for _, node := range nodes {
		_, a := current[node.ID]
		_, b := reference[node.ID]
		if a && b {
			shared, found = node, true
			break
		}
	}
	if !found {
		return nil, false, nil
	}
	for _, graph := range []Graph{{Nodes: input.Nodes, Edges: input.Edges}, *input.Reference} {
		if _, handled, err := nativeAuthoredPositions(ctx, graph.Nodes, graph.Edges, sizes); err != nil || !handled {
			return nil, handled, err
		}
	}
	// Match the canonical anchor in graph-focus.ts, including translation direction.
	anchor, moving := reference, current
	if current[shared.ID] == shared {
		anchor, moving = current, reference
	}
	origin := moving[shared.ID].Position
	dx, dy := shared.Position.X-origin.X, shared.Position.Y-origin.Y
	if math.IsNaN(dx) || math.IsNaN(dy) || math.IsInf(dx, 0) || math.IsInf(dy, 0) {
		return nil, false, nil
	}
	translated := make(map[string]Point, len(moving))
	translatedNodes := make([]PlanNode, 0, len(moving))
	for id, node := range moving {
		if err := ctx.Err(); err != nil {
			return nil, true, err
		}
		position := Point{node.Position.X + dx, node.Position.Y + dy}
		fixed, exists := anchor[id]
		if math.IsNaN(position.X) || math.IsNaN(position.Y) || math.IsInf(position.X, 0) || math.IsInf(position.Y, 0) || exists && position != fixed.Position {
			return nil, false, nil
		}
		translated[id] = position
		node.Position = position
		translatedNodes = append(translatedNodes, node)
	}
	if _, handled, err := nativeAuthoredPositions(ctx, translatedNodes, nil, sizes); err != nil || !handled {
		return nil, handled, err
	}
	aligned := append([]PlanNode(nil), nodes...)
	for i, node := range aligned {
		if fixed, exists := anchor[node.ID]; exists {
			aligned[i].Position = fixed.Position
		} else {
			aligned[i].Position = translated[node.ID]
		}
	}
	return nativeGridPositions(ctx, aligned, edges, sizes)
}

func nativeGridPositions(ctx context.Context, nodes []PlanNode, edges []PlanEdge, sizes map[string]Size) ([]nativeNode, bool, error) {
	columns, rows := make(map[float64]float64), make(map[float64]float64)
	dimensions := make([]Size, len(nodes))
	for i, node := range nodes {
		size := sizes[node.ID]
		if size.Width == 0 {
			size.Width = 248
		}
		if size.Height == 0 {
			size.Height = 160
		}
		dimensions[i] = size
		if prior, ok := columns[node.Position.X]; !ok || size.Width > prior {
			columns[node.Position.X] = size.Width
		}
		if prior, ok := rows[node.Position.Y]; !ok || size.Height > prior {
			rows[node.Position.Y] = size.Height
		}
	}
	largest := 24.0
	for _, edge := range edges {
		if err := ctx.Err(); err != nil {
			return nil, true, err
		}
		largest = math.Max(largest, nativeMeasureLabel(edge.Label).height+16)
	}
	rowGap := math.Max(120, largest*2+32)
	place := func(values map[float64]float64, gap float64) {
		keys := make([]float64, 0, len(values))
		for key := range values {
			keys = append(keys, key)
		}
		sort.Float64s(keys)
		x := 24.0
		for _, key := range keys {
			dimension := values[key]
			values[key] = x
			x += dimension + gap
		}
	}
	place(columns, 264)
	place(rows, rowGap)
	placed := make([]nativeNode, len(nodes))
	for i, node := range nodes {
		placed[i] = nativeNode{id: node.ID, kind: node.Kind, LayoutNode: LayoutNode{Position: Point{columns[node.Position.X], rows[node.Position.Y]}, Width: dimensions[i].Width, Height: dimensions[i].Height}}
	}
	return placed, true, nil
}

func nativePortPoint(node nativeNode, port nativePort, outside float64) Point {
	x, y := port.Offset, port.Offset
	switch port.Side {
	case "left":
		x = -outside
	case "right":
		x = node.Width + outside
	case "top":
		y = -outside
	case "bottom":
		y = node.Height + outside
	}
	return Point{node.Position.X + x, node.Position.Y + y}
}
func nativeCompact(points []Point) []Point {
	n := 0
	for _, p := range points {
		if n > 0 && points[n-1] == p {
			continue
		}
		if n > 1 && (points[n-2].X == points[n-1].X && points[n-1].X == p.X || points[n-2].Y == points[n-1].Y && points[n-1].Y == p.Y) {
			n--
		}
		points[n] = p
		n++
	}
	return points[:n]
}

func nativeRouteGraphEdges(ctx context.Context, placed []nativeNode, edges []PlanEdge) (map[string]LayoutEdge, error) {
	const clearance, spacing = 24.0, 16.0
	routes := make(map[string]LayoutEdge, len(edges))
	if len(edges) == 0 {
		return routes, ctx.Err()
	}
	byID := make(map[string]int, len(placed))
	columns, rows := make(map[float64]float64), make(map[float64]float64)
	boxes := make([]nativeBox, len(placed))
	left := math.Inf(1)
	right := math.Inf(-1)
	for i, node := range placed {
		byID[node.id] = i
		boxes[i] = nativeBox{node.Position.X, node.Position.Y, node.Width, node.Height}
		left = math.Min(left, node.Position.X)
		right = math.Max(right, node.Position.X+node.Width)
		columns[node.Position.X] = math.Max(columns[node.Position.X], node.Width)
		rows[node.Position.Y] = math.Max(rows[node.Position.Y], node.Height)
	}
	type endpoint struct {
		source, target, sourcePort, targetPort int
		label                                  nativeLabel
		kind                                   string
	}
	endpoints := make([]endpoint, len(edges))
	widest, rowHeight := 120.0, 24.0
	outgoing := make(map[string]bool, len(edges))
	for _, edge := range edges {
		outgoing[edge.Source] = true
	}
	for i, edge := range edges {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		si, sourceOK := byID[edge.Source]
		ti, targetOK := byID[edge.Target]
		if !sourceOK || !targetOK {
			return nil, fmt.Errorf("连线 %s 引用了不存在的节点", edge.ID)
		}
		source, target := &placed[si], &placed[ti]
		returning := target.Position.Y < source.Position.Y || si == ti
		sideExit := target.kind == "failure" || target.kind == "result" && target.Position.X != source.Position.X && !outgoing[target.id]
		skipForward := false
		if !returning && source.Position.X == target.Position.X {
			for _, node := range placed {
				if node.Position.X == source.Position.X && node.Position.Y > source.Position.Y && node.Position.Y < target.Position.Y {
					skipForward = true
					break
				}
			}
		}
		kind := "flow"
		if sideExit {
			kind = "exception"
		} else if returning {
			kind = "return"
		}
		ss, ts := "right", "left"
		switch {
		case skipForward:
			ss, ts = "right", "right"
		case kind == "return" && source.Position.X == target.Position.X:
			ss, ts = "left", "left"
			if si == ti {
				ss, ts = "right", "right"
			}
		case returning && source.Position.X == target.Position.X:
			ss, ts = "right", "right"
		case source.Position.X == target.Position.X:
			ss, ts = "bottom", "top"
		case source.Position.X > target.Position.X:
			ss, ts = "left", "right"
		}
		sp := len(source.ports)
		source.ports = append(source.ports, nativePort{Port: Port{ID: "source:" + edge.ID, Type: "source", Side: ss}, partner: ti})
		tp := len(target.ports)
		target.ports = append(target.ports, nativePort{Port: Port{ID: "target:" + edge.ID, Type: "target", Side: ts}, partner: si})
		label := nativeMeasureLabel(edge.Label)
		label.width = math.Max(120, label.width)
		label.height += 16
		widest = math.Max(widest, label.width)
		rowHeight = math.Max(rowHeight, label.height)
		endpoints[i] = endpoint{si, ti, sp, tp, label, kind}
	}
	rowGap := math.Max(120, rowHeight*2+32)
	corridors := func(values map[float64]float64, horizontal bool) []float64 {
		keys := make([]float64, 0, len(values))
		for key := range values {
			keys = append(keys, key)
		}
		sort.Float64s(keys)
		result := make([]float64, 0, len(keys)*6)
		for _, start := range keys {
			end := start + values[start]
			if horizontal {
				result = append(result, start-32, end+32, end+rowGap/2, end+rowGap-32)
			} else {
				result = append(result, start-64, start-24, end+24, end+64, end+132, end+200)
			}
		}
		return result
	}
	corridorXs, corridorYs := corridors(columns, false), corridors(rows, true)
	for ni := range placed {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		node := &placed[ni]
		for _, side := range []string{"top", "right", "bottom", "left"} {
			ports := make([]int, 0, len(node.ports))
			for i, port := range node.ports {
				if port.Side == side {
					ports = append(ports, i)
				}
			}
			sort.SliceStable(ports, func(i, j int) bool {
				a, b := node.ports[ports[i]], node.ports[ports[j]]
				one, two := placed[a.partner].Position, placed[b.partner].Position
				horizontalSide := side == "left" || side == "right"
				oneReturns, twoReturns := horizontalSide && a.Type == "target", horizontalSide && b.Type == "target"
				if oneReturns != twoReturns {
					return !oneReturns
				}
				if oneReturns {
					sign := func(x float64) int {
						if x < 0 {
							return -1
						}
						if x > 0 {
							return 1
						}
						return 0
					}
					x, y := sign(one.Y-node.Position.Y), sign(two.Y-node.Position.Y)
					if x != y {
						return x < y
					}
					if one.Y != two.Y {
						return two.Y < one.Y
					}
					return nativeCompareIDs(b.ID, a.ID) < 0
				}
				if horizontalSide {
					if one.Y != two.Y {
						return one.Y < two.Y
					}
				} else if one.X != two.X {
					return one.X < two.X
				}
				return nativeCompareIDs(a.ID, b.ID) < 0
			})
			span := node.Height
			if side == "top" || side == "bottom" {
				span = node.Width
			}
			for i, index := range ports {
				node.ports[index].Offset = 16 + (span-32)*float64(i+1)/float64(len(ports)+1)
			}
			gutterOrder := make([]int, 0, len(ports))
			fromBelow := func(index int) bool {
				port := node.ports[index]
				return port.Type == "target" && placed[port.partner].Position.Y > node.Position.Y
			}
			for _, index := range ports {
				if !fromBelow(index) {
					gutterOrder = append(gutterOrder, index)
				}
			}
			for i := len(ports) - 1; i >= 0; i-- {
				if fromBelow(ports[i]) {
					gutterOrder = append(gutterOrder, ports[i])
				}
			}
			gap := math.Inf(1)
			for _, other := range boxes {
				if side == "left" && other.x+other.width <= node.Position.X {
					gap = math.Min(gap, node.Position.X-other.x-other.width)
				} else if side == "right" && other.x >= node.Position.X+node.Width {
					gap = math.Min(gap, other.x-node.Position.X-node.Width)
				}
			}
			step := math.Min(spacing, math.Max(0, gap-clearance*2)/float64(max(1, len(ports)-1)))
			for i, index := range gutterOrder {
				gutter := clearance
				if side == "left" || side == "right" {
					// Explicit rounding prevents Go's fused multiply-add from changing JS coordinates.
					gutter += float64(float64(i) * step)
				}
				node.ports[index].gutter = gutter
			}
		}
	}
	order := make([]int, len(edges))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := endpoints[order[i]], endpoints[order[j]]
		priority := func(kind string) int {
			if kind == "return" {
				return 2
			}
			if kind == "exception" {
				return 1
			}
			return 0
		}
		if priority(a.kind) != priority(b.kind) {
			return priority(a.kind) < priority(b.kind)
		}
		x, y := math.Abs(placed[a.source].Position.Y-placed[a.target].Position.Y), math.Abs(placed[b.source].Position.Y-placed[b.target].Position.Y)
		if x != y {
			return x < y
		}
		return nativeCompareIDs(edges[order[i]].ID, edges[order[j]].ID) < 0
	})
	occupiedLabels := make([]nativeBox, 0, len(edges))
	occupiedSegments := make([]nativeSegment, 0, len(edges)*5)
	parallelTracks := func(coordinate float64, horizontal bool) []float64 {
		occupied := make([]float64, 0, len(occupiedSegments))
		for _, line := range occupiedSegments {
			if horizontal && line.a.Y == line.b.Y {
				occupied = append(occupied, line.a.Y)
			} else if !horizontal && line.a.X == line.b.X {
				occupied = append(occupied, line.a.X)
			}
		}
		free := func(value float64) bool {
			for _, prior := range occupied {
				if math.Abs(value-prior) < spacing-.01 {
					return false
				}
			}
			return true
		}
		if free(coordinate) {
			return []float64{coordinate}
		}
		result := []float64{coordinate}
		for _, direction := range []float64{-1, 1} {
			value := coordinate
			for step := 0; step <= len(occupied); step++ {
				value += direction * spacing
				if free(value) {
					break
				}
			}
			result = append(result, value)
		}
		return result
	}
	returnLane := 0
	selfLanes := make(map[string]int)
	for _, index := range order {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		edge, ep := edges[index], endpoints[index]
		source, target := placed[ep.source], placed[ep.target]
		sp, tp := source.ports[ep.sourcePort], target.ports[ep.targetPort]
		first, last := nativePortPoint(source, sp, 0), nativePortPoint(target, tp, 0)
		start, end := nativePortPoint(source, sp, sp.gutter), nativePortPoint(target, tp, tp.gutter)
		lane := 0
		self := ep.source == ep.target
		if self {
			lane = selfLanes[edge.Source]
			selfLanes[edge.Source] = lane + 1
		} else if ep.kind == "return" {
			lane = returnLane
			returnLane++
		}
		laneX := left - widest/2 - 48 - float64(lane)*spacing
		if self {
			laneX = source.Position.X + source.Width + widest + 48 + float64(lane)*spacing
		} else if source.Position.X != target.Position.X {
			laneX = (start.X + end.X) / 2
		}
		baseRails := corridorXs
		if ep.kind == "return" {
			baseRails = []float64{laneX}
		} else if ep.kind == "exception" || source.Position.X == target.Position.X {
			baseRails = make([]float64, 0, len(corridorXs))
			threshold := source.Position.X + source.Width + clearance
			if ep.kind == "exception" {
				threshold = math.Min(start.X, end.X)
			}
			for _, x := range corridorXs {
				if x >= threshold {
					baseRails = append(baseRails, x)
				}
			}
		}
		rails := make([]float64, 0, len(baseRails)*3)
		seen := make(map[float64]bool)
		for _, rail := range baseRails {
			for _, track := range parallelTracks(rail, false) {
				if !seen[track] {
					rails = append(rails, track)
					seen[track] = true
				}
			}
		}
		search := nativeRouteSearch{ctx: ctx, boxes: boxes, occupiedLabels: occupiedLabels, occupiedSegments: occupiedSegments, label: ep.label,
			wireCosts: make(map[nativeSegment]float64), labelPlaces: make(map[nativeSegment]nativeLabelPlace)}
		add := func(points ...Point) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			middle := nativeCompact(points)
			for i := 1; i < len(middle); i++ {
				for _, box := range boxes {
					if nativeCrosses(middle[i-1], middle[i], box, 16) {
						return nil
					}
				}
			}
			var buffer [8]Point
			full := append(buffer[:0], first)
			full = append(full, middle...)
			full = append(full, last)
			return search.consider(nativeCompact(full))
		}
		if start.X == end.X || start.Y == end.Y {
			if err := add(start, end); err != nil {
				return nil, err
			}
		} else {
			if err := add(start, Point{start.X, end.Y}, end); err != nil {
				return nil, err
			}
			if err := add(start, Point{end.X, start.Y}, end); err != nil {
				return nil, err
			}
		}
		for _, rail := range rails {
			if err := add(start, Point{rail, start.Y}, Point{rail, end.Y}, end); err != nil {
				return nil, err
			}
		}
		if ep.kind != "return" {
			for _, rail := range corridorYs {
				for _, track := range parallelTracks(rail, true) {
					if err := add(start, Point{start.X, track}, Point{end.X, track}, end); err != nil {
						return nil, err
					}
				}
			}
		}
		sourceTracks := append(parallelTracks(source.Position.Y-32, true), parallelTracks(source.Position.Y+source.Height+32, true)...)
		targetTracks := append(parallelTracks(target.Position.Y-32, true), parallelTracks(target.Position.Y+target.Height+32, true)...)
		for _, rail := range rails {
			for _, startY := range sourceTracks {
				for _, endY := range targetTracks {
					if err := add(start, Point{start.X, startY}, Point{rail, startY}, Point{rail, endY}, Point{end.X, endY}, end); err != nil {
						return nil, err
					}
				}
			}
		}
		if search.best == nil && ep.kind == "return" && !self {
			for _, rail := range []float64{left - widest - 64 - float64(lane)*spacing, right + widest + 64 + float64(lane)*spacing} {
				for _, track := range parallelTracks(rail, false) {
					if err := add(start, Point{track, start.Y}, Point{track, end.Y}, end); err != nil {
						return nil, err
					}
					for _, startY := range sourceTracks {
						for _, endY := range targetTracks {
							if err := add(start, Point{start.X, startY}, Point{track, startY}, Point{track, endY}, Point{end.X, endY}, end); err != nil {
								return nil, err
							}
						}
					}
				}
			}
		}
		if search.best == nil {
			return nil, fmt.Errorf("未能在节点外布置连线 %s", edge.ID)
		}
		width, height := ep.label.width, ep.label.height
		routes[edge.ID] = LayoutEdge{Points: search.best, Label: search.bestLabel, SourceHandle: sp.ID, TargetHandle: tp.ID, LabelWidth: &width, LabelHeight: &height, Kind: ep.kind}
		occupiedLabels = append(occupiedLabels, nativeLabelBox(search.bestLabel, ep.label))
		for i := 1; i < len(search.best); i++ {
			occupiedSegments = append(occupiedSegments, nativeSegment{search.best[i-1], search.best[i]})
		}
	}
	return routes, nil
}

type nativeLabelPlace struct {
	point      Point
	collisions int
	cost       float64
	valid      bool
}
type nativeRouteSearch struct {
	ctx                   context.Context
	boxes, occupiedLabels []nativeBox
	occupiedSegments      []nativeSegment
	label                 nativeLabel
	wireCosts             map[nativeSegment]float64
	labelPlaces           map[nativeSegment]nativeLabelPlace
	best                  []Point
	bestLabel             Point
	bestCollisions        int
	bestScore             float64
}

// Candidates are scored in source order as they are generated; only a winner is
// retained. Generation depends only on already completed edges, not the winner.
func (s *nativeRouteSearch) consider(points []Point) error {
	length := 0.0
	for i := 1; i < len(points); i++ {
		length += math.Abs(points[i-1].X-points[i].X) + math.Abs(points[i-1].Y-points[i].Y)
	}
	baseCost := length + float64(len(points))*24
	if s.best != nil && s.bestCollisions == 0 && baseCost >= s.bestScore {
		return nil
	}
	wireCost := 0.0
	for i := 1; i < len(points); i++ {
		line := nativeSegment{points[i-1], points[i]}
		cost, ok := s.wireCosts[line]
		if !ok {
			for j, prior := range s.occupiedSegments {
				if j%64 == 0 {
					if err := s.ctx.Err(); err != nil {
						return err
					}
				}
				if line.a.X == line.b.X && prior.a.X == prior.b.X {
					cost += float64(math.Max(0, math.Min(math.Max(line.a.Y, line.b.Y), math.Max(prior.a.Y, prior.b.Y))-math.Max(math.Min(line.a.Y, line.b.Y), math.Min(prior.a.Y, prior.b.Y))) * math.Max(0, 16-math.Abs(line.a.X-prior.a.X)) * 1000)
				} else if line.a.Y == line.b.Y && prior.a.Y == prior.b.Y {
					cost += float64(math.Max(0, math.Min(math.Max(line.a.X, line.b.X), math.Max(prior.a.X, prior.b.X))-math.Max(math.Min(line.a.X, line.b.X), math.Min(prior.a.X, prior.b.X))) * math.Max(0, 16-math.Abs(line.a.Y-prior.a.Y)) * 1000)
				} else if (line.a.X == line.b.X) != (prior.a.X == prior.b.X) {
					vertical, horizontal := prior, prior
					if line.a.X == line.b.X {
						vertical = line
					}
					if line.a.Y == line.b.Y {
						horizontal = line
					}
					if vertical.a.X >= math.Min(horizontal.a.X, horizontal.b.X) && vertical.a.X <= math.Max(horizontal.a.X, horizontal.b.X) && horizontal.a.Y >= math.Min(vertical.a.Y, vertical.b.Y) && horizontal.a.Y <= math.Max(vertical.a.Y, vertical.b.Y) {
						cost += 1000
					}
				}
			}
			collisions := 0
			for _, obstacle := range s.occupiedLabels {
				if nativeCrosses(line.a, line.b, obstacle, 4) {
					collisions++
				}
			}
			cost += float64(collisions) * 3000
			s.wireCosts[line] = cost
		}
		wireCost += cost
		if s.best != nil && s.bestCollisions == 0 && baseCost+wireCost >= s.bestScore {
			return nil
		}
	}
	for i := 1; i < len(points); i++ {
		line := nativeSegment{points[i-1], points[i]}
		place, ok := s.labelPlaces[line]
		if !ok {
			vertical := line.a.X == line.b.X
			span, needed := math.Abs(line.a.X-line.b.X), s.label.width
			if vertical {
				span, needed = math.Abs(line.a.Y-line.b.Y), s.label.height
			}
			if span >= needed+12 {
				for _, fraction := range []float64{.5, .25, .75, .15, .85} {
					point := Point{line.a.X + float64((line.b.X-line.a.X)*fraction), line.a.Y + float64((line.b.Y-line.a.Y)*fraction)}
					bounds := nativeLabelBox(point, s.label)
					blocked := false
					for _, node := range s.boxes {
						if nativeIntersects(bounds, node, 12) {
							blocked = true
							break
						}
					}
					if blocked {
						continue
					}
					collisions := 0
					for _, prior := range s.occupiedLabels {
						if nativeIntersects(bounds, prior, 8) {
							collisions++
						}
					}
					crossings := 0
					for _, prior := range s.occupiedSegments {
						if nativeCrosses(prior.a, prior.b, bounds, 4) {
							crossings++
						}
					}
					cost := float64(crossings) * 3000
					if !place.valid || collisions < place.collisions || collisions == place.collisions && cost < place.cost {
						place = nativeLabelPlace{point, collisions, cost, true}
					}
					if collisions == 0 && cost == 0 {
						break
					}
				}
			}
			s.labelPlaces[line] = place
		}
		if !place.valid {
			continue
		}
		score := baseCost + wireCost + place.cost
		if s.best == nil || place.collisions < s.bestCollisions || place.collisions == s.bestCollisions && score < s.bestScore {
			s.best = append(s.best[:0], points...)
			s.bestLabel = place.point
			s.bestCollisions = place.collisions
			s.bestScore = score
		}
		if s.bestCollisions == 0 && s.bestScore == baseCost+wireCost {
			return nil
		}
	}
	return nil
}
