// Test
// <- punctuation.definition.comment.begin
// ^^^^ comment.line

/* Test */
// <- punctuation.definition.comment.begin
// ^^^^^^ comment.block
//      ^^ punctuation.definition.comment.end

package com.example.app;
// <- keyword.other.package

import java.util.List;
// <- keyword.other.import

public class Test {
// <- storage.modifier
//     ^ storage.modifier.class
//           ^ entity.name.type.class
  public static void main(String[] args) {
//                   ^ entity.name.function
    String test = """
    """;
//  ^^^ string.quoted.triple.block.java
//  ^^^ punctuation.definition.string.end
    int count = 42;
//  ^ storage.type.integral
//              ^ constant.numeric
    boolean done = false;
//                 ^ constant.language.boolean
    System.out.println(test);
  }
}
