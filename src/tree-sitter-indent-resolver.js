const { Emitter } = require("@lumine-code/event-kit");
const Point = require("./point");
const { comparePoints, resolveNodePosition } = require("./tree-sitter-node-helpers");

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * A class that manages indentation hinting for a single editor.
 *
 * Each instance of `TreeSitterLanguageMode` has exactly one instance of
 * `IndentResolver`; the purpose of this class is to encapsulate indentation
 * logic instead of having it dominate the language mode for those
 * familiarizing themselves with the code.
 *
 * @private
 */
class IndentResolver {
  constructor(buffer, languageMode) {
    this.buffer = buffer;
    this.languageMode = languageMode;
    this.emitter = new Emitter();
  }

  // Get the suggested indentation level for an existing line in the
  // buffer.
  //
  // See {@link TreeSitterLanguageMode#suggestedIndentForBufferRow}.
  suggestedIndentForBufferRow(row, tabLength, rawOptions = {}) {
    if (row === 0) {
      return 0;
    }
    let root = this.languageMode.rootLanguageLayer;
    if (!root || !root.tree || !root.ready) {
      return null;
    }
    let { languageMode } = this;
    let options = {
      // Whether to skip emitting the `did-suggest-indent` event.
      skipEvent: false,
      // Whether to skip blank lines when finding a comparison row.
      skipBlankLines: true,
      // Whether to skip the second (dedent) phase of indentation hinting.
      skipDedentCheck: false,
      // Whether to account for the leading whitespace that already exists on
      // the row when returning an indentation level.
      preserveLeadingWhitespace: false,
      // A cache of existing indentation levels to reduce work when resuming
      // an indentation hint started earlier. Takes the form of a `Map` whose
      // keys are line numbers and whose values are indentation levels.
      indentationLevels: null,
      // Whether to force a re-parse of the tree if we think the tree is dirty.
      forceTreeParse: false,
      ...rawOptions,
    };

    // We can also pass a `tree` option to tell this method to re-use a
    // specific tree. In those cases, we also include a `controllingLayer`
    // option as a sanity check; the tree can only be reused if the controlling
    // layer is still the one we expect.
    let originalControllingLayer = options.controllingLayer;

    // Indentation hinting is a two-phase process.
    //
    // In phase 1, we determine `row`’s starting indent considering only the
    // content of the previous row.
    //
    // In phase 2, we consider `row`’s own content to see if any of it suggests
    // an alteration from the phase 1 value.
    //
    // To start, we check the previous row (typically the nearest row with text
    // on it) to know what our indentation “baseline” ought to be.
    let comparisonRow = options.comparisonRow ?? this.getComparisonRow(row, options);

    let existingIndent = 0;
    if (options.preserveLeadingWhitespace) {
      // When this option is true, the indent level we return will be _added
      // to_ however much indentation is already present on the line. Whatever
      // the purpose of this option, we can't just pretend it isn't there,
      // because it will produce silly outcomes. Instead, let's account for
      // that level of indentation and try to subtract it from whatever level
      // we return later on.
      //
      // Sadly, if the row is _more_ indented than we need it to be, we won't
      // be able to dedent it into the correct position when
      // `preserveLeadingWhitespace` is `true`. This option probably needs to
      // be revisited.
      existingIndent = this.indentLevelForLine(this.buffer.lineForRow(row), tabLength);
    }

    let comparisonRowIndent = options.comparisonRowIndent;
    if (comparisonRowIndent === undefined) {
      comparisonRowIndent = languageMode.indentLevelForLine(
        this.buffer.lineForRow(comparisonRow),
        tabLength,
      );
    }

    // What's the right place to measure from? Often we're here because the
    // user just hit Enter, which means we'd run before injection layers have
    // been re-parsed. Hence the injection's language layer might not know
    // whether it controls the point at the cursor. So instead we look for the
    // layer that controls the point at the end of the comparison row. This may
    // not always be correct, but we'll find out.
    let comparisonRowEnd = new Point(comparisonRow, this.buffer.lineLengthForRow(comparisonRow));

    // Phase 1
    // -------
    //
    // Find the controlling layer and perform an indentation query that starts
    // at the beginning of the comparison row and ends at the beginning of the
    // current row.

    // Find the deepest layer that actually has an indents query. (Layers that
    // don't define one, such as specialized injection grammars, are telling us
    // they don't care about indentation. If a grammar wants to _prevent_ a
    // shallower layer from controlling indentation, it should define an empty
    // `indents.scm`, perhaps with an explanatory comment.)
    let controllingLayer = languageMode.controllingLayerAtPoint(comparisonRowEnd, (layer) => {
      if (!layer.queries.indentsQuery) return false;
      // We want to exclude layers with a content range that _begins at_ the
      // cursor position. Why? Because the content that starts at the cursor
      // is about to shift down to the next line. It'd be odd if that layer
      // was in charge of the indentation hint if it didn't have any content
      // on the preceding line.
      //
      // So first we test for containment exclusive of endpoints…
      if (layer.containsPoint(comparisonRowEnd, true)) {
        return true;
      }

      // …but we'll still accept layers that have a content range which
      // _ends_ at the cursor position.
      return layer.getCurrentRanges()?.some((r) => {
        return r.end.compare(comparisonRowEnd) === 0;
      });
    });

    if (!controllingLayer) {
      // There's no layer with an indents query to help us out. The default
      // behavior in this situation with any grammar — even plain text — is to
      // match the previous line's indentation.
      let finalIndent = comparisonRowIndent - existingIndent;
      if (!options.skipEvent) {
        this.emitter.emit("did-suggest-indent", {
          currentRow: row,
          comparisonRow,
          finalIndent,
        });
      }
      return finalIndent;
    }

    let {
      queries: { indentsQuery },
      scopeResolver,
    } = controllingLayer;

    // TODO: We use `ScopeResolver` here so that we can use its tests. Maybe we
    // need a way to share those tests across different kinds of capture
    // resolvers.
    scopeResolver.reset();

    let indentTree = null;
    if (options.tree && originalControllingLayer === controllingLayer) {
      // Make sure this tree belongs to the layer we expect it to.
      indentTree = options.tree;
    }

    // In practice, we want to use synchronous hinting whenever we can. Here we
    // opt into synchronous hinting when
    //
    // * we don't have to re-parse the tree;
    // * we are explicitly told to re-parse the tree;
    // * we think we can afford to spend the time to re-parse the tree.
    //
    // Indentation hinting can be expensive because it runs with every
    // individual change, even within transactions! And since each individual
    // change changes the tree, triggering hinting in the middle of a
    // transaction forces a re-parse that otherwise wouldn't have happened
    // until the transaction was finished. It's cheaper to wait until the end
    // of a transaction and invoke auto-indentation over the entire transaction
    // extent, but this can easily produce a different (and less accurate)
    // outcome than synchronous hinting.
    //
    // We still need asynchronous hinting for edge cases. A re-parse costs
    // time, and any package can programmaticaly create a buffer transaction
    // that triggers indentation hinting an arbitrary number of times, so we
    // must guard against those scenarios no matter how rare they are. The
    // `shouldUseAsyncIndent` method on the language mode manages that; it
    // tells us whether we can spare the time we'll spend to do a tree
    // re-parse.
    if (!indentTree) {
      if (
        !controllingLayer.treeIsDirty ||
        options.forceTreeParse ||
        !languageMode.shouldUseAsyncIndent()
      ) {
        // If we're in this code path, it either means the tree is clean (the
        // `get` path) or that we're willing to spend the time to do a
        // synchronous reparse (the `parse` path). Either way, we'll be able to
        // deliver a synchronous answer to the question.
        indentTree = controllingLayer.getOrParseTree();
      } else {
        // We can't answer this yet because we don't yet have a new syntax
        // tree, and are unwilling to spend time doing a synchronous re-parse.
        // Return a promise that will fulfill once the transaction is over.
        //
        // TODO: For async, we might need an approach where we suggest a
        // preliminary indent level and then follow up later with a more
        // accurate one. It's a bit disorienting that the editor falls back to
        // an indent level of `0` when a newline is inserted.
        let comparisonRowText = this.buffer.lineForRow(comparisonRow);
        let rowText = this.buffer.lineForRow(row);
        return languageMode.atTransactionEnd().then(({ changeCount }) => {
          let shouldFallback = false;
          // If this was the only change in the transaction, then we can
          // definitely adjust the indentation level after the fact. If not,
          // then we might still be able to make indentation decisions in cases
          // where they do not affect one another.
          //
          // Hence if neither the comparison row nor the current row has had
          // its contents change in any way since we were first called, we will
          // assume it's safe to adjust the indentation level after the fact.
          // Otherwise we'll fall back to a single transaction-wide indentation
          // adjustment — fewer tree parses, but more likely to produce unusual
          // results.
          if (changeCount > 1) {
            if (comparisonRowText !== this.buffer.lineForRow(comparisonRow)) {
              shouldFallback = true;
            }
            if (rowText !== this.buffer.lineForRow(row)) {
              shouldFallback = true;
            }
          }
          if (shouldFallback) {
            // When we think the buffer has changed too much for our hint to be
            // relevant, we return `undefined`, signalling to the `TextEditor`
            // that its only recourse is to auto-indent the whole extent of the
            // transaction instead.
            return undefined;
          }

          // If we get this far, it's safe to auto-indent this line. Either it
          // was the only change in its transaction or the other changes
          // happened on different lines. But we've retained the original
          // values for `comparisonRow` and `comparisonRowIndent` because
          // that's the proper basis from which to determine the given row's
          // indent level.
          let result = this.suggestedIndentForBufferRow(row, tabLength, {
            ...rawOptions,
            comparisonRow: comparisonRow,
            comparisonRowIndent: comparisonRowIndent,
            tree: controllingLayer.tree,
            controllingLayer,
          });
          return result;
        });
      }
    }

    // Keep track of the range of each capture so we can filter out duplicates.
    let positionSet = new Set();

    // Perform the Phase 1 capture.
    let indentCaptures = indentsQuery.captures(indentTree.rootNode, {
      startPosition: { row: comparisonRow, column: 0 },
      endPosition: { row: row, column: 0 },
    });

    // Keep track of the first `@indent` capture on the line. When balancing
    // `@indent`s and `@dedent`s, any `@dedent`s that occur before the first
    // `@indent` should be ignored.
    let indentCapturePosition = null;
    // Three different capture styles can influence the Phase 1 output:
    // the `@indent`/`@dedent` balancing…
    let indentDelta = 0;
    // …the `@dedent.next` capture…
    let dedentNextDelta = 0;
    // …and the `@match.next` capture, which acts as a special sort of override
    // much like Phase 2’s `@match` capture.
    let matchNextResult = null;

    for (let capture of indentCaptures) {
      let { node, name } = capture;
      // Captures that have no content are ignored by default because they
      // typically are “phantom” nodes inserted by Tree-sitter as part of error
      // recovery, but we'll allow them if the query file explicitly tells us
      // to.
      let allowEmpty = this.getProperty(capture, "allowEmpty", "boolean", false);
      if (node.startIndex === node.endIndex && !allowEmpty) {
        continue;
      }

      // Ignore anything that isn't actually on the row.
      if (node.endPosition.row < comparisonRow) {
        continue;
      }
      if (node.startPosition.row > comparisonRow) {
        continue;
      }

      // Ignore anything that fails a scope test. This applies all the tests of
      // the form `(#is? test.foo)`.
      if (!scopeResolver.store(capture, { boundaries: false })) {
        continue;
      }
      // Apply indentation-specific scope tests and skip this capture if any
      // tests fail. This applies all tests of the form `(#is? indent.foo)`.
      let passed = this.applyTests(capture, {
        currentRow: row,
        comparisonRow,
        tabLength,
      });
      if (!passed) {
        continue;
      }

      // Only consider a given combination of capture name and buffer range
      // once, even if it's captured more than once in `indents.scm`.
      let key = `${name}/${node.startIndex}/${node.endIndex}`;
      if (positionSet.has(key)) {
        continue;
      }
      positionSet.add(key);

      if (name === "indent") {
        // This capture hints at an increase in indentation level.
        if (indentCapturePosition === null) {
          indentCapturePosition = node.endPosition;
        }
        indentDelta++;
      } else if (name === "dedent.next") {
        // This isn't often needed, but it's a way for the current line to
        // signal that the _next_ line should be dedented no matter what its
        // content is.
        dedentNextDelta++;
      } else if (name === "match.next") {
        // `@match.next` tells us that the current row’s baseline should match
        // that of a given position descriptor.
        matchNextResult =
          this.resolveMatch(capture, {
            currentRow: row,
            comparisonRow,
            tabLength,
            indentationLevels: options.indentationLevels,
          }) ?? null;
        if (matchNextResult !== null) {
          // If we succeed in resolving this value, it’ll supersede any other
          // kinds of captures, so we can skip the rest of the capture
          // processing.
          break;
        }
      } else if (name === "dedent") {
        // `dedent` tokens don't count for anything unless they happen
        // after the first `indent` token. They only tell us whether an indent
        // that _seems_ like it should happen is cancelled out.
        //
        // Consider:
        //
        // } else if (foo) {
        //
        // We should still indent the succeeding line because the initial `}`
        // does not cancel out the `{` at the end of the line. On the other
        // hand:
        //
        // } else if (foo) {}
        //
        // The second `}` _does_ cancel out the first occurrence of `{` because
        // it comes later.
        if (
          !indentCapturePosition ||
          comparePoints(node.startPosition, indentCapturePosition) < 0
        ) {
          // This capture either happened before the first indent capture on
          // the row or is _the same node_ as the indent capture, in which case
          // we should construe the dedent as happening _before_ the indent.
          //
          // For example: the "elsif" node in Ruby triggers a dedent on its own
          // line, but also signals an indent on the next line. The dedent
          // shouldn't cancel out the indent.
          continue;
        }
        // Now that we've filtered out all the `@dedent`s we should ignore, we
        // can decrement `indentDelta`.
        indentDelta--;
        if (indentDelta < 0) {
          // In the _indent_ phase, the delta won't ever go lower than `0`.
          // This is because we assume that the previous line is correctly
          // indented! The only function that `dedent` serves for us in this
          // phase is canceling out an earlier `indent` and preventing false
          // positives.
          //
          // So no matter how many `dedent` tokens we see on a particular line…
          // if the _last_ token we see is an `indent` token, then it hints
          // that the next line should be indented by one level.
          //
          // The only ways for Phase 1 to produce a baseline indent that’s
          // _less_ than the comparison row’s indent are via `@dedent.next` and
          // `@match.next`.
          indentDelta = 0;
        }
      }
    }

    // `@indent` and `@dedent` can increase the next line's indent level by one
    // at most, and can't decrease the next line's indent level at all on their
    // own.
    //
    // Why? There are few coding patterns in the wild that would cause us to
    // indent more than one level based on tokens found on the _previous_ line.
    // And there are also few scenarios in which we'd want to dedent a certain
    // line before we even know the content of that line.
    //
    // Hence we distill the results above into a net indentation level change
    // of either 1 or 0, depending on whether we saw more `@indent`s than
    // `@dedent`s.
    //
    // If there's a genuine need to dedent the current row based solely on the
    // content of the comparison row, then `@dedent.next` or `@match.next` can
    // be used.
    //
    indentDelta = clamp(indentDelta, 0, 1);

    // Process `@dedent.next` captures after the `@indent`/`@dedent` balancing;
    // they act as a strong hint about the next line's indentation.
    indentDelta -= clamp(dedentNextDelta, 0, 1);

    // On the other hand, if we got a result from a `@match.next` capture, that
    // supersedes any other results. Set `indentDelta` to `0`; we'll instead
    // use `matchNextResult` as the baseline to which we'll add any further
    // deltas.
    if (matchNextResult !== null) {
      indentDelta = 0;
    }

    // Phase 2
    // -------
    //
    // Find the controlling layer and perform an indentation query that starts
    // at the beginning of the current row and ends at the beginning of the
    // next row.

    let dedentDelta = 0;
    let lineText = this.buffer.lineForRow(row);
    let rowStartingColumn = Math.max(lineText.search(/\S/), 0);

    if (!options.skipDedentCheck) {
      scopeResolver.reset();

      // The controlling layer on the previous line got to decide what our
      // starting indent was on the current line. But it might not extend to
      // the current line, so we should determine which layer is in charge of
      // the second phase.
      //
      // The comparison point we use is that of the first non-whitespace
      // character on the line. If we start earlier than that, we might not
      // pick up on the presence of an injection layer.
      let rowStart = new Point(row, rowStartingColumn);
      let dedentControllingLayer = languageMode.controllingLayerAtPoint(rowStart, (layer) => {
        if (!layer.queries.indentsQuery) return false;
        // We're inverting the logic from above: now we want to allow layers
        // that _begin_ at the cursor and exclude layers that _end_ at the
        // cursor. Because we'll be analyzing content that comes _after_ the
        // cursor to understand whether to dedent!
        //
        // So first we test for containment exclusive of endpoints…
        if (layer.containsPoint(rowStart, true)) {
          return true;
        }

        // …but we'll still accept layers that have a content range which
        // _starts_ at the cursor position.
        return layer.getCurrentRanges()?.some((r) => {
          return r.start.compare(rowStart) === 0;
        });
      });

      if (dedentControllingLayer && dedentControllingLayer !== controllingLayer) {
        // If this layer is different from the one we used above, then we
        // should run this layer's indents query against its own tree. (If _no_
        // layers qualify at this position, we won't hit this code path, so
        // we'll reluctantly still use the original layer and tree.)
        //
        // NOTE: This strange edge case bypasses all of the heuristics we
        // defined above that govern synchronous vs. asynchronous hinting.
        //
        // In our defense, the cost of this reparse is still accounted for in
        // the reparse budget. Also, it's not clear that such a tree would even
        // need a re-parse, since the buffer change that leads to this edge
        // case will often happen outside of this language layer.
        //
        // Still, if we find an edge case in which this might be a problem, we
        // should decide what to do here. It would feel a bit weird to go async
        // this late in the hinting process, so one option might be to
        // determine `dedentControllingLayer` at the same time as
        // `controllingLayer` so that it can be considered when making the
        // initial decision between sync/async hinting.
        indentsQuery = dedentControllingLayer.queries.indentsQuery;
        indentTree = dedentControllingLayer.getOrParseTree();
      }

      // Perform the Phase 2 capture.
      let dedentCaptures = indentsQuery.captures(indentTree.rootNode, {
        startPosition: { row: row - 1, column: Infinity },
        endPosition: { row: row + 1, column: 0 },
      });

      let currentRowText = lineText.trim();
      // We can reuse the position set we created for Phase 1.
      positionSet.clear();

      for (let capture of dedentCaptures) {
        let { name, node } = capture;
        let { text } = node;

        // As in Phase 1, we allow captures to opt into being recognized even
        // when they're empty.
        let allowEmpty = this.getProperty(capture, "allowEmpty", "boolean", false);
        if (text === "" && !allowEmpty) {
          continue;
        }

        // `(#set! indent.force)` acts more aggressively, signaling dedent even
        // when the capture isn't the first content on the row. This should be
        // used with care.
        let force = this.getProperty(capture, "force", "boolean", false);

        // Ignore anything that isn't actually on the row.
        if (node.endPosition.row < row) {
          continue;
        }
        if (node.startPosition.row > row) {
          continue;
        }

        // Ignore anything that fails a scope test.
        if (!scopeResolver.store(capture, { boundaries: false })) {
          continue;
        }
        // Apply indentation-specific scope tests and skip this capture if any
        // tests fail.
        let passed = this.applyTests(capture, {
          currentRow: row,
          comparisonRow,
          tabLength,
        });
        if (!passed) {
          continue;
        }

        // Imagine you've got:
        //
        // { ^foo, bar } = something
        //
        // and the caret represents the cursor. Pressing Enter will move
        // everything after the cursor to a new line and _should_ indent the
        // line, even though there's a closing brace on the new line that would
        // otherwise mark a dedent.
        //
        // Thus we don't want to honor a `@dedent` or `@match` capture unless
        // it's the first non-whitespace content in the line. We'll use similar
        // logic for `suggestedIndentForEditedBufferRow`.
        //
        // If a capture is confident it knows what it's doing, it can opt out
        // of this behavior with `(#set! indent.force true)`.
        if (!force && !currentRowText.startsWith(text)) {
          continue;
        }

        // The `@match` capture short-circuits nearly all indentation logic by
        // pointing us to a different node and asking us to match the
        // indentation of whatever row that node starts on.
        if (name === "match") {
          let matchIndentLevel = this.resolveMatch(capture, {
            currentRow: row,
            comparisonRow,
            tabLength,
            indentationLevels: options.indentationLevels,
          });
          if (typeof matchIndentLevel === "number") {
            // We were able to resolve the `@match` capture, so we’ll be
            // returning early.
            scopeResolver.reset();
            let finalIndent = Math.max(matchIndentLevel - Math.floor(existingIndent), 0);
            if (!options.skipEvent) {
              this.emitter.emit("did-suggest-indent", {
                currentRow: row,
                comparisonRow,
                matchIndentLevel,
                finalIndent,
                captureMode: "match",
              });
            }
            return finalIndent;
          }
        } else if (name === "none") {
          // TODO: `@none` is an experiment for any situation in which the
          // current line’s indent should be reset to `0`. This is obviously
          // rarely needed and I can’t remember exactly what the envisioned use
          // case was, but we’ll leave it in for now.
          scopeResolver.reset();
          if (!options.skipEvent) {
            this.emitter.emit("did-suggest-indent", {
              currentRow: row,
              comparisonRow,
              finalIndent: 0,
              captureMode: "none",
            });
          }
          return 0;
        }

        // Only the captures handled above and `@dedent` can change this line's
        // indentation. So now we’ll filter out all non-`@dedent`s.
        if (name !== "dedent") {
          continue;
        }

        // Only consider a given range once, even if it's marked with multiple
        // captures.
        let key = `${node.startIndex}/${node.endIndex}`;
        if (positionSet.has(key)) {
          continue;
        }
        positionSet.add(key);
        dedentDelta--;
      }

      // `@indent`/`@dedent` captures, no matter how many there are, can
      // dedent the current line by one level at most. To indent more than
      // that, one must use a `@match` capture.
      dedentDelta = clamp(dedentDelta, -1, 0);
    }

    scopeResolver.reset();

    // Both phases are complete, so let's put the pieces together.

    // Where are we starting from? Most of the time it's the indentation level
    // of the comparison row, but a `@match.next` capture can override this.
    let baseline = matchNextResult !== null ? matchNextResult : comparisonRowIndent;

    // Now we add the deltas from the two phases. This will nearly always
    // produce a difference of either `-1`, `0`, or `1` from `baseline`.
    //
    // When `@match.next` produces a baseline, `indentDelta` will always be `0`
    // to signify that other Phase 1 logic was ignored altogether.
    let finalIndent = baseline + indentDelta + dedentDelta;

    // Finally, we might have to adjust for the existing leading whitespace if
    // `options.preserveLeadingWhitespace` is `true`.
    //
    // We call `Math.floor` because we should only subtract whole units of
    // indentation here. “Leading whitespace” seems not to consider (for
    // example) a single leading space character if `editor.tabLength` is `2`.
    let adjustedIndent = Math.max(finalIndent - Math.floor(existingIndent), 0);

    // Emit an event with all this information. This makes it possible for
    // tooling to help a grammar author understand the indentation logic
    // without necessarily having to step through it in a debugger.
    if (!options.skipEvent) {
      this.emitter.emit("did-suggest-indent", {
        currentRow: row,
        comparisonRow,
        comparisonRowIndent,
        indentDelta,
        dedentDelta,
        finalIndent,
        adjustedIndent,
        captureMode: "normal",
      });
    }

    return adjustedIndent;
  }

  /**
   * @public
   * @status extended
   *
   * Register a callback that fires when `IndentResolver` suggests an
   * indentation level.
   *
   * This callback is merely a glimpse into the indentation life-cycle and does
   * not offer the callback any opportunity to change the value being
   * suggested. Its goal is to report metadata that may make it easier to
   * diagnose _why_ a particular indentation level is being suggested without
   * having to step through the logic in a debugger.
   *
   * Nearly all exit paths for {@link #suggestedIndentForBufferRow} and
   * {@link #suggestedIndentForEditedBufferRow} invoke this callback.
   *
   * One indentation “level” consists of either (a) one tab character, or (b)
   * one multiple of `editor.tabLength` spaces (if `editor.softTabs` is
   * `true`).
   *
   * - `callback` A `Function` that takes one parameter:
   *   - `meta` An `Object` consisting of _some subset_ of the following
   *     properties:
   *     - `captureMode` A `String` describing one of several different modes
   *       which influence a capture; when this property is absent, it means
   *       that indentation level was determined in a simpler manner that
   *       did not use any Tree-sitter features.
   *       - A value of `normal` means that an indentation level was determined
   *         through the normal two-phase process.
   *       - A value of `match` means that an indentation level was determined
   *         when we encountered a `@match` capture. `@match` captures are
   *         considered in Phase 2, but use the syntax tree to override earlier
   *         logic and give a definitive answer on a row’s indentation level.
   *       - A value of `none` means that a `@none` capture was encountered in
   *         Phase 2. `@none` is an extremely rare capture that, when used,
   *         instantly signals a suggested indent level of `0`, overriding all
   *         other logic.
   *     - `currentRow` The `Number` of the row whose indentation was suggested.
   *       (Zero-indexed, so you must add one to match the row number displayed
   *       in the gutter.)
   *     - `comparisonRow` The `Number` of the row that was consulted to
   *       determine the baseline indentation of the target row. This is
   *       often the row directly above `row`, but can be an earlier row if
   *       the target row was preceded by whitespace. (Zero-indexed just like
   *       `currentRow`.)
   *     - `comparisonRowIndent` `Number` The indentation level of the
   *       comparison row.
   *     - `indentDelta` `Number` The amount of indentation (in increments)
   *       suggested during the first phase of indent analysis. This phase
   *       determines the baseline indentation of the target row by querying
   *       the content on the comparison row. (For instance, if the comparison
   *       row ends with `(`, `indentDelta` will typically be `1`.) Since
   *       the first phase can only maintain or increase the indentation level,
   *       this value will be either `0` or `1`.
   *     - `dedentDelta` `Number` The amount of indentation (in increments)
   *       suggested during the second phase of indent analysis. This phase
   *       determines whether any content on the target line suggests that we
   *       should dedent the line by one level. (For instance, if the target
   *       line starts with `)`, `dedentDelta` will often be `-1`.) Since the
   *       second phase can only maintain or decrease the indentation level,
   *       this value will be either `0` or `-1`.
   *     - `matchIndentLevel` `Number` A number representing the ideal amount
   *       of indentation as determined by a `@match` capture. A `@match`
   *       capture tries to match the indentation level of a previous line in
   *       the buffer — one that it has a semantic relationship with — instead
   *       of determining indentation in relative terms. When it's present, it
   *       overrides the conventional indentation logic.
   *     - `finalIndent` `Number` A number representing the final value that
   *       will shortly be returned from a call to
   *       `suggestedIndentForBufferRow`. This value does not account for the
   *       `preserveLeadingWhitespace` option; it represents what the actual
   *       indentation level of the line is going to be.
   *     - `adjustedIndent` `Number` Like `finalIndent`, but takes existing
   *       indentation level into account if the `preserveLeadingWhitespace`
   *       option was enabled. For instance, if `finalIndent` is `5`, but the
   *       target row already has an indent level of `3`, `adjustedIndent` will
   *       instead be `2`. If `preserveLeadingWhitespace` is `false`,
   *       `finalIndent` and `adjustedIndent` will always be identical.
   */
  onDidSuggestIndent(callback) {
    return this.emitter.on("did-suggest-indent", callback);
  }

  suggestedIndentForBufferRows(startRow, endRow, tabLength, options = {}) {
    let { languageMode } = this;
    let root = languageMode.rootLanguageLayer;
    if (!root || !root.tree) {
      let results = new Map();
      for (let row = startRow; row <= endRow; row++) {
        results.set(row, null);
      }
      return results;
    }

    let results = new Map();
    let comparisonRow = null;
    let comparisonRowIndent = null;

    let { isPastedText = false } = options;
    let indentDelta;

    for (let row = startRow; row <= endRow; row++) {
      // If this row were being indented by `suggestedIndentForBufferRow`, it'd
      // look at the end of the previous row to find the controlling layer,
      // because we start at the previous row to find the suggested indent for
      // the current row.
      let controllingLayer = languageMode.controllingLayerAtPoint(
        this.buffer.clipPosition(new Point(row - 1, Infinity)),
        // This query isn't as precise as the one we end up making later, but
        // that's OK. This is just a first pass.
        (layer) => !!layer.queries.indentsQuery && !!layer.tree,
      );
      if (isPastedText) {
        // In this mode, we're not trying to auto-indent every line; instead,
        // we're trying to auto-indent the _first_ line of a region of text
        // that's just been pasted, while trying to preserve the relative
        // levels of indentation within the pasted region. So if the
        // auto-indent of the first line increases its indent by one level,
        // all other lines should also be increased by one level — without even
        // consulting their own suggested indent levels.
        if (row === startRow) {
          // The only time we consult the indents query is for the first row,
          // so we're not going to insist that the _entire range_ fall under
          // the control of a layer with an indents query — just the row we
          // need.
          if (!controllingLayer) {
            return null;
          }
          let tree = controllingLayer.getOrParseTree();

          let firstLineCurrentIndent = this.indentLevelForLine(
            this.buffer.lineForRow(row),
            tabLength,
          );

          let firstLineIdealIndent = this.suggestedIndentForBufferRow(row, tabLength, {
            ...options,
            controllingLayer,
            tree,
          });

          if (firstLineIdealIndent == null) {
            // If we decline to suggest an indent level for the first line,
            // then there's no change to be made here. Keep the whole region
            // the way it is.
            return null;
          } else {
            indentDelta = firstLineIdealIndent - firstLineCurrentIndent;
            if (indentDelta === 0) {
              // If the first row doesn't have to be adjusted, neither do any
              // others.
              return null;
            }
            results.set(row, firstLineIdealIndent);
          }
          continue;
        }

        // All rows other than the first are easy — just apply the delta.
        let actualIndent = this.indentLevelForLine(this.buffer.lineForRow(row), tabLength);

        results.set(row, actualIndent + indentDelta);
        continue;
      }

      // For line X to know its appropriate indentation level, it needs row X-1,
      // if it exists, to be indented properly. That's why `TextEditor` wants to
      // indent each line atomically. Instead, we'll determine the right level
      // for the first row, then supply the result for the previous row when we
      // call `suggestedIndentForBufferRow` for the _next_ row, and so on, so
      // that `suggestedIndentForBufferRow` doesn't try to look up the comparison
      // row itself and find out we haven't actually fixed any of the previous
      // rows' indentations yet.
      let indent;
      if (controllingLayer) {
        let tree = controllingLayer.getOrParseTree();
        let rowOptions = {
          ...options,
          tree,
          comparisonRow: comparisonRow ?? undefined,
          comparisonRowIndent: comparisonRowIndent ?? undefined,
          indentationLevels: results,
        };
        indent = this.suggestedIndentForBufferRow(row, tabLength, rowOptions);
        if (indent === null) {
          // We could not retrieve the correct indentation level for this row
          // without re-parsing the tree. We should give up and return what we
          // have so that `TextEditor` can finish the job through a less
          // efficient means.
          return results;
        }
      } else {
        // We could not retrieve the correct indentation level for this row
        // because it isn't governed by any layer that has an indents query.
        return results;
      }
      results.set(row, indent);
      comparisonRow = row;
      comparisonRowIndent = indent;
    }

    return results;
  }

  suggestedIndentForEditedBufferRow(row, tabLength, options = {}) {
    let { languageMode } = this;
    const line = this.buffer.lineForRow(row);
    const currentRowIndent = this.indentLevelForLine(line, tabLength);
    let comparisonRow = options.comparisonRow ?? this.getComparisonRow(row, options);

    // If the row is not indented at all, we have nothing to do, because we can
    // only dedent a line at this phase.
    if (currentRowIndent === 0) {
      return;
    }

    // If we're on the first row, we have no preceding line to compare
    // ourselves to. We should do nothing.
    if (row === 0) {
      return;
    }

    // By the time this function runs, we probably know enough to be sure of
    // which layer controls the beginning of this row, even if we don't know
    // which one owns the position at the cursor.
    //
    // Use the position of the first text on the line as the reference point.
    let rowStartingColumn = Math.max(line.search(/\S/), 0);
    let rowStartingPoint = new Point(row, rowStartingColumn);
    let controllingLayer = languageMode.controllingLayerAtPoint(rowStartingPoint, (layer) => {
      if (!layer.queries.indentsQuery) return false;
      // We're using the same logic here that we used in the dedent phase of
      // `suggestedIndentForBufferRow`: allow layers that _begin_ at the
      // cursor, but exclude layers that _end_ at the cursor.
      //
      // So first we test for containment exclusive of endpoints…
      if (layer.containsPoint(rowStartingPoint, true)) {
        return true;
      }

      // …but we'll still accept layers that have a content range which
      // _starts_ at the cursor position.
      return layer.getCurrentRanges()?.some((r) => {
        return r.start.compare(rowStartingPoint) === 0;
      });
    });

    if (!controllingLayer) {
      return undefined;
    }

    let {
      queries: { indentsQuery },
      scopeResolver,
    } = controllingLayer;
    if (!indentsQuery) {
      return undefined;
    }

    // TODO: We use `ScopeResolver` here so that we can use its tests. Maybe we
    // need a way to share those tests across different kinds of capture
    // resolvers.
    scopeResolver.reset();

    // Ideally, we're running when the tree is clean, but if not, we must
    // re-parse the tree in order to make an accurate indents query.
    let indentTree = options.tree;
    if (!indentTree) {
      // Unlike `suggestedIndentForBufferRow`, this method is not something
      // that can run in the middle of a transaction. That means we don't need
      // to consult the reparse budget.
      if (
        !controllingLayer.treeIsDirty ||
        options.forceTreeParse ||
        !languageMode.useAsyncIndent ||
        !languageMode.useAsyncParsing
      ) {
        indentTree = controllingLayer.getOrParseTree();
      } else {
        return languageMode.atTransactionEnd().then(({ changeCount }) => {
          if (changeCount > 1) {
            // Unlike `suggestedIndentForBufferRow`, we should not return
            // `undefined` here and implicitly tell `TextEditor` to handle the
            // auto-indent itself. If there were several changes in this
            // transaction, we missed our chance to dedent this row, and should
            // return `null` to signal that `TextEditor` should do nothing
            // about it.
            return null;
          }
          let result = this.suggestedIndentForEditedBufferRow(row, tabLength, {
            ...options,
            tree: controllingLayer.tree,
          });
          if (currentRowIndent === result) {
            // Return `null` here so that `TextEditor` realizes that no work
            // needs to be done.
            return null;
          }
          return result;
        });
      }
    }

    if (!indentTree) {
      console.error(`No indent tree!`, controllingLayer.inspect());
      return undefined;
    }

    const indents = indentsQuery.captures(indentTree.rootNode, {
      startPosition: { row: row - 1, column: Infinity },
      endPosition: { row: row + 1, column: 0 },
    });

    let lineText = this.buffer.lineForRow(row).trim();

    // This is the indent level that is suggested from context — the level we'd
    // have if this row were completely blank. We won't alter the indent level
    // of the current row — even if it's “wrong” — unless typing triggers a
    // dedent. But once a dedent is triggered, we should dedent one level from
    // this value, not from the current row indent.
    //
    // If more than one level of dedent is needed, a `@match` capture must be
    // used so that indent level can be expressed in absolute terms.
    const originalRowIndent = this.suggestedIndentForBufferRow(row, tabLength, {
      skipBlankLines: true,
      skipDedentCheck: true,
      skipEvent: true,
      tree: indentTree,
    });

    let seenDedent = false;
    for (let indent of indents) {
      let { node } = indent;
      // Ignore captures that aren't on this row.
      if (node.startPosition.row !== row) {
        continue;
      }
      // Ignore captures that fail their scope tests.
      if (!scopeResolver.store(indent, { boundaries: false })) {
        continue;
      }
      // Apply indentation-specific scope tests and skip this capture if any
      // tests fail.
      let passed = this.applyTests(indent, {
        currentRow: row,
        comparisonRow,
        tabLength,
      });
      if (!passed) return;

      let force = this.getProperty(indent, "force", "boolean", false);

      // For all captures — even `@match` captures — we get one bite at the
      // apple, and it's when the text of the capture is the only
      // non-whitespace text on the line.
      //
      // Otherwise, this capture will assert itself after every keystroke, and
      // the user has no way to opt out of the correction.
      //
      // If the capture is confident it knows what it's doing, and is using
      // some other mechanism to ensure the adjustment will happen exactly
      // once, it can bypass this behavior with `(#set! indent.force true)`.
      //
      if (!force && node.text !== lineText) {
        continue;
      }

      // `@match` is authoritative; honor the first one we see and ignore other
      // captures.
      if (indent.name === "match") {
        let matchIndentLevel = this.resolveMatch(indent, {
          currentRow: row,
          comparisonRow,
          tabLength,
        });
        if (typeof matchIndentLevel === "number") {
          scopeResolver.reset();
          this.emitter.emit("did-suggest-indent", {
            currentRow: row,
            comparisonRow,
            matchIndentLevel,
            finalIndent: matchIndentLevel,
            captureMode: "match",
          });
          return matchIndentLevel;
        }
      } else if (indent.name === "none") {
        scopeResolver.reset();
        this.emitter.emit("did-suggest-indent", {
          currentRow: row,
          comparisonRow,
          finalIndent: 0,
          captureMode: "none",
        });
        return 0;
      }

      if (indent.name !== "dedent") {
        continue;
      }

      // Even after we've seen a `@dedent`, we allow the loop to continue,
      // because we'd prefer a `@match` capture over this `@dedent` capture
      // even if it happened to come later in the loop.
      seenDedent = true;
    }

    scopeResolver.reset();

    let finalIndent = seenDedent ? Math.max(0, originalRowIndent - 1) : currentRowIndent;

    this.emitter.emit("did-suggest-indent", {
      currentRow: row,
      comparisonRow,
      finalIndent,
      captureMode: "normal",
    });

    return finalIndent;
  }

  getComparisonRow(row, { skipBlankLines = true } = {}) {
    let comparisonRow = row - 1;
    if (skipBlankLines) {
      // It usually makes no sense to compare to a blank row, so we'll move
      // upward until we find a line with text on it.
      while (this.buffer.isRowBlank(comparisonRow) && comparisonRow > 0) {
        comparisonRow--;
      }
    }
    return comparisonRow;
  }

  indentLevelForLine(line, tabLength) {
    let indentLength = 0;
    for (let i = 0, { length } = line; i < length; i++) {
      const char = line[i];
      if (char === "\t") {
        indentLength += tabLength - (indentLength % tabLength);
      } else if (char === " ") {
        indentLength++;
      } else {
        break;
      }
    }
    return indentLength / tabLength;
  }

  resolveMatch(capture, { currentRow, tabLength, indentationLevels }) {
    let { node } = capture;

    // `indent.match` used to be called `indent.matchIndentOf`.
    let matchIndentOf = this.getProperty(capture, ["match", "matchIndentOf"], "string", null);
    // `indent.offset` used to be called `indent.offsetIndent`.
    let offsetIndent = this.getProperty(capture, ["offset", "offsetIndent"], "number", 0);

    // A `@match` or `@match.next` capture must have an `indent.match`
    // predicate. If it’s missing, the capture is invalid and we should pretend
    // it wasn’t there at all.
    if (!matchIndentOf) return undefined;

    // Turn an `indent.match` predicate into a node position.
    let targetPosition = resolveNodePosition(node, matchIndentOf);
    let targetRow = targetPosition?.row;
    // If we fail to resolve the node position, it means the path described
    // doesn't exist. We should behave as though this `@match` capture wasn’t
    // present at all.
    if (typeof targetRow !== "number" || targetRow >= currentRow) {
      return undefined;
    }

    let baseIndent;
    if (indentationLevels) {
      baseIndent = indentationLevels.get(targetRow);
    }
    baseIndent ??= this.languageMode.indentLevelForLine(
      this.buffer.lineForRow(targetRow),
      tabLength,
    );

    let result = baseIndent + offsetIndent;

    // Because `indent.offset` can be any number, we can wind up with a
    // negative number here, which is invalid.
    return Math.max(result, 0);
  }

  // Look up an `indent.` capture property applied with a `#set!` directive,
  // optionally coercing to a specified type or falling back to a default
  // value.
  //
  // `names` can be an array in cases where the property may have several
  // aliases. The first one that exists will be returned. (Omit the leading
  // `indent.` when passing property names.)
  getProperty(capture, names, coercion = null, fallback = null) {
    let { setProperties: props = {} } = capture;
    if (typeof names === "string") {
      names = [names];
    }
    for (let name of names) {
      let fullName = `indent.${name}`;
      if (!(fullName in props)) {
        continue;
      }
      return this.coerce(props[fullName], coercion) ?? fallback;
    }
    return fallback;
  }

  coerce(value, coercion) {
    switch (coercion) {
      case String:
      case "string":
        if (value == null) return "";
        return value;
      case Number:
      case "number": {
        let number = Number(value);
        if (isNaN(number)) return null;
        return number;
      }
      case Boolean:
      case "boolean":
        if (value == null) return null;
        return true;
      default:
        return value;
    }
  }

  applyTests(capture, meta) {
    let { node, assertedProperties: asserted = {}, refutedProperties: refuted = {} } = capture;
    for (let [name, test] of Object.entries(IndentResolver.TESTS)) {
      let fullName = `indent.${name}`;
      let passed = true;
      if (asserted[fullName]) {
        passed = test(node, asserted[fullName], meta);
      } else if (refuted[fullName]) {
        passed = !test(node, refuted[fullName], meta);
      }
      if (!passed) return false;
    }
    return true;
  }
}

// Indentation queries have a small number of query tests. These can't be
// implemented as generic scope tests because they expose metadata that only
// makes sense in an indentation context.
IndentResolver.TESTS = {
  // Returns `true` if the position descriptor's row equals that of the current
  // row (the row whose indentation level is being suggested).
  //
  // For example:
  //
  //   (#is? indent.matchesCurrentRow startPosition)
  //
  // in a `@match` capture will pass if the captured node starts on the current
  // row.
  matchesCurrentRow(node, value, { currentRow }) {
    let position = resolveNodePosition(node, value);
    if (!position) return null;
    return position.row === currentRow;
  },

  // Returns `true` if the position descriptor's row equals that of the
  // comparison row (the row used as a reference when determining the
  // indentation level of the current row).
  //
  // For example:
  //
  //   (#is? indent.matchesComparisonRow endPosition)
  //
  // in a `@match` capture will pass if the captured node ends on the
  // comparison row.
  matchesComparisonRow(node, value, { comparisonRow }) {
    let position = resolveNodePosition(node, value);
    if (!position) return null;
    return position.row === comparisonRow;
  },
};

module.exports = IndentResolver;
