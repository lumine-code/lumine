// Grammar tests for the Tree-sitter Go grammar.
// <- comment.line.double-slash.go

package main
// <- keyword

import (
	"fmt"
	"strings"
)

const Limit = 25
//            ^ constant.numeric.integer.go

type Counter struct {
//   ^ entity.name.type.go
	total int
	tags  []string
}

func (c *Counter) Tally(label string, step int) int {
//                ^ entity.name.function.method.go
	c.total += step
	if strings.HasPrefix(label, "x") {
		return c.total
	}
	for i := 0; i < 3; i++ {
		c.total++
	}
	fmt.Println("done", label)
	return c.total
}

func main() {
//   ^ entity.name.function.go
	c := &Counter{}
	c.Tally("a", 1)
}
