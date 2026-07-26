// Grammar tests for the Tree-sitter Rust grammar.
// <- comment.line.double-slash.rust

/* A block comment. */
// <- comment.block.rust

use std::collections::HashMap;
// <- keyword.control

#[derive(Debug)]
//  ^ entity.other.attribute-name.rust

pub struct Counter {
//         ^ storage.type.other.rust
    total: u32,
//         ^ storage.type.builtin.rust
    tags: HashMap<String, &'static str>,
//                         ^ keyword.operator.lifetime.rust
}

impl Counter {
    pub fn tally(&mut self, label: &str, step: f64) -> u32 {
//         ^ entity.name.function.rust
//                 ^ storage.modifier.mut.rust
        let enabled = true;
//                    ^ constant.language.boolean
        let ratio = 1.5;
//                  ^ constant.numeric.decimal.float.rust
        println!("{} {}", label, step);
//      ^ support.other.function.rust
//               ^ string.quoted.double.rust
        self.total += 1;
//      ^ variable.language.self.rust
        42
//      ^ constant.numeric.decimal.integer.rust
    }
}
