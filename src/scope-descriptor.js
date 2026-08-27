/**
 * @public
 * @status extended
 *
 * Wraps an `Array` of `String`s. The Array describes a path from the
 * root of the syntax tree to a token including _all_ scope names for the entire
 * path.
 *
 * Methods that take a `ScopeDescriptor` will also accept an `Array` of `String`
 * scope names e.g. `['.source.js']`.
 *
 * You can use `ScopeDescriptor`s to get language-specific config settings via
 * {@link Config#get}.
 *
 * You should not need to create a `ScopeDescriptor` directly.
 *
 * * {@link TextEditor#getRootScopeDescriptor} to get the language's descriptor.
 * * {@link TextEditor#scopeDescriptorForBufferPosition} to get the descriptor at a
 *   specific position in the buffer.
 * * {@link Cursor#getScopeDescriptor} to get a cursor's descriptor based on position.
 *
 * See the [scopes and scope descriptor guide](https://lumine-code.github.io/docs.html#customizing-lumine/language-settings)
 * for more information.
 */
module.exports = class ScopeDescriptor {
  static fromObject(scopes) {
    if (scopes instanceof ScopeDescriptor) {
      return scopes;
    } else if (Array.isArray(scopes)) {
      return new ScopeDescriptor({ scopes });
    } else {
      throw new TypeError("A scope must be a ScopeDescriptor or an array of scope names");
    }
  }

  /**
   * @category Construction and Destruction
   */

  /**
   * @public
   * @status public
   *
   * Create a {@link ScopeDescriptor} object.
   *
   * @param {Object} object - Scope data.
   * @param {Array<String>} object.scopes - The ordered syntax scopes.
   */
  constructor({ scopes }) {
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string" || !scope)) {
      throw new TypeError("ScopeDescriptor scopes must be an array of non-empty strings");
    }
    this.scopes = scopes;
  }

  /**
   * @public
   * @status public
   *
   * @returns {Array} of `Strings`
   */
  getScopesArray() {
    return this.scopes;
  }

  getScopeChain() {
    // For backward compatibility, prefix TextMate-style scope names with
    // leading dots (e.g. 'source.js' -> '.source.js').
    if (this.scopes[0] != null && this.scopes[0].includes(".")) {
      let result = "";
      for (let i = 0; i < this.scopes.length; i++) {
        const scope = this.scopes[i];
        if (i > 0) {
          result += " ";
        }
        if (scope[0] !== ".") {
          result += ".";
        }
        result += scope;
      }
      return result;
    } else {
      return this.scopes.join(" ");
    }
  }

  toString() {
    return this.getScopeChain();
  }

  isEqual(other) {
    if (this.scopes.length !== other.scopes.length) {
      return false;
    }
    for (let i = 0; i < this.scopes.length; i++) {
      const scope = this.scopes[i];
      if (scope !== other.scopes[i]) {
        return false;
      }
    }
    return true;
  }
};
