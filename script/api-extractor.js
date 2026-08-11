"use strict";

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const API_STATUS_VALUES = new Map([
  ["essential", "Essential"],
  ["extended", "Extended"],
  ["public", "Public"],
  ["experimental", "Experimental"],
]);
const API_STATUSES = new Set(API_STATUS_VALUES.values());
const IGNORED_AST_KEYS = new Set([
  "loc",
  "start",
  "end",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && entry.name.endsWith(".js") ? [fullPath] : [];
  });
}

function visit(node, ancestors, callback) {
  if (!node || typeof node !== "object") return;
  callback(node, ancestors.at(-1), ancestors);
  for (const [key, value] of Object.entries(node)) {
    if (IGNORED_AST_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, [...ancestors, node], callback);
    } else {
      visit(value, [...ancestors, node], callback);
    }
  }
}

function cleanBlockComment(value) {
  return value
    .replace(/^\*+/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

function commentText(comments = []) {
  return comments
    .map((comment) =>
      comment.type === "CommentBlock"
        ? cleanBlockComment(comment.value)
        : comment.value.startsWith(" ")
          ? comment.value.slice(1)
          : comment.value,
    )
    .join("\n")
    .trim();
}

function commentsFor(node, ancestors = []) {
  for (const candidate of [node, ...ancestors.toReversed()]) {
    if (candidate?.leadingComments?.length) return candidate.leadingComments;
  }
  return [];
}

function ownComments(node, ancestors = []) {
  for (const candidate of [node, ...ancestors.toReversed().slice(0, 2)]) {
    if (candidate?.leadingComments?.length) return candidate.leadingComments;
  }
  return [];
}

function adjacentComments(statement) {
  const kept = [];
  let nextLine = statement.loc.start.line;
  for (const comment of (statement.leadingComments || []).toReversed()) {
    if (comment.loc.end.line < nextLine - 1) break;
    kept.unshift(comment);
    nextLine = comment.loc.start.line;
  }
  return kept;
}

function isDirective(raw) {
  return /^\s*(eslint|prettier|ts-|@ts-|istanbul|globals?|jshint)\b/.test(raw);
}

function firstParagraph(markdown) {
  return markdown
    .split(/\n\s*\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
}

function indefiniteArticle(type) {
  if (/^U(?:RI|RL)/.test(type)) return "A";
  return /^[AEIO]/i.test(type) ? "An" : "A";
}

function normalizeStatus(value, context) {
  const sourceStatus = value || "public";
  const status = API_STATUS_VALUES.get(sourceStatus);
  if (!status) {
    throw new Error(
      `Invalid @status "${sourceStatus}"${context ? ` on ${context}` : ""}; expected ${[
        ...API_STATUS_VALUES.keys(),
      ].join(", ")}.`,
    );
  }
  return status;
}

function tagBlocks(raw) {
  const lines = raw.split("\n");
  const description = [];
  const tags = [];
  let current = null;
  let index = 0;

  // Public API comments keep their visibility metadata first so editors show
  // it immediately. Consume that fixed header before reading the prose; a
  // generic tag parser would otherwise treat the description as @status's
  // multiline value.
  while (index < lines.length && !lines[index].trim()) index++;
  let foundHeader = false;
  while (index < lines.length) {
    const match = lines[index].match(/^\s*@(public|private|status)(?:\s+([\s\S]*))?$/);
    if (!match) break;
    tags.push({ name: match[1], value: (match[2] || "").trim() });
    foundHeader = true;
    index++;
  }
  if (foundHeader) {
    while (index < lines.length && !lines[index].trim()) index++;
  } else {
    index = 0;
  }

  let readingTags = false;
  for (; index < lines.length; index++) {
    const line = lines[index];
    const match = line.match(/^\s*@([\w-]+)(?:\s+([\s\S]*))?$/);
    if (match) {
      current = { name: match[1], value: (match[2] || "").trim() };
      tags.push(current);
      readingTags = true;
    } else if (readingTags && current) {
      current.value = `${current.value}\n${line}`;
    } else {
      description.push(line);
    }
  }
  for (const tag of tags) tag.value = tag.value.trim();
  return { description: description.join("\n").trim(), tags };
}

function tagValue(tags, name) {
  return tags.find((tag) => tag.name === name)?.value || "";
}

function parseParamTag(value) {
  const match = value.match(/^\s*(?:\{([^}]+)\}\s*)?(\[[^\]]+\]|[^\s-]+)?\s*(?:-\s*)?([\s\S]*)$/);
  if (!match?.[2]) return null;
  let name = match[2];
  let optional = false;
  let defaultValue = null;
  if (name.startsWith("[") && name.endsWith("]")) {
    optional = true;
    name = name.slice(1, -1);
    const equals = name.indexOf("=");
    if (equals >= 0) {
      defaultValue = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
  }
  return {
    name,
    type: match[1] || null,
    description: match[3].replace(/\s+/g, " ").trim(),
    optional,
    defaultValue,
  };
}

function parseReturnTag(value) {
  const match = value.match(/^\s*(?:\{([^}]+)\}\s*)?([\s\S]*)$/);
  return {
    type: match?.[1] || null,
    description: match?.[2]?.replace(/\s+/g, " ").trim() || "",
  };
}

function parseTypeTag(value) {
  return value.match(/^\s*\{([^}]+)\}/)?.[1]?.trim() || value.trim().split(/\s+/, 1)[0] || null;
}

function parseJsdoc(raw, context, strict) {
  const { description, tags } = tagBlocks(raw);
  const hasPublic = tags.some((tag) => tag.name === "public");
  const hasPrivate = tags.some((tag) => tag.name === "private");
  const hasDocumentTag = tags.some((tag) =>
    [
      "status",
      "category",
      "class",
      "classdesc",
      "desc",
      "function",
      "param",
      "return",
      "returns",
      "type",
    ].includes(tag.name),
  );
  const categoryOnly = tags.length > 0 && tags.every((tag) => tag.name === "category");
  if (strict && hasDocumentTag && !hasPublic && !hasPrivate && !categoryOnly) {
    throw new Error(`JSDoc on ${context} must declare @public or @private.`);
  }
  if (strict && hasPublic && !tags.some((tag) => tag.name === "status")) {
    throw new Error(`Public JSDoc on ${context} must declare @status.`);
  }
  if (hasPrivate || (!hasPublic && !hasDocumentTag)) return null;

  if (categoryOnly) {
    return {
      visibility: null,
      description: "",
      summary: "",
      category: tagValue(tags, "category") || null,
      parameters: [],
      returns: null,
      propertyType: null,
      documented: false,
      format: "jsdoc",
    };
  }

  const explicitDescription = tagValue(tags, "classdesc") || tagValue(tags, "desc") || description;
  const status = normalizeStatus(tagValue(tags, "status"), context);
  const returnTag = tags.find((tag) => tag.name === "returns" || tag.name === "return");
  const typeTag = tags.find((tag) => tag.name === "type");
  const parsedReturn = returnTag ? parseReturnTag(returnTag.value) : null;
  if (strict && returnTag && !parsedReturn.type) {
    throw new Error(`@${returnTag.name} on ${context} must declare a type in braces.`);
  }
  if (strict && parsedReturn?.type?.startsWith("@link ")) {
    throw new Error(
      `@${returnTag.name} on ${context} must use a structured type, not {@link ...}.`,
    );
  }
  if (strict && typeTag && !/^\s*\{(?!@link\b)[^}]+\}/.test(typeTag.value)) {
    throw new Error(`@type on ${context} must declare a structured type in braces.`);
  }
  const propertyType = parseTypeTag(typeTag?.value || "");
  return {
    visibility: status,
    description: explicitDescription,
    summary: firstParagraph(explicitDescription),
    category: tagValue(tags, "category") || null,
    parameters: tags
      .filter((tag) => tag.name === "param")
      .map((tag) => parseParamTag(tag.value))
      .filter(Boolean),
    returns: parsedReturn,
    propertyType,
    documented: true,
    format: "jsdoc",
  };
}

function parseDoc(comments, { context, strict }) {
  const jsdoc = comments
    .filter((comment) => comment.type === "CommentBlock")
    .map((comment) => parseJsdoc(commentText([comment]), context, strict))
    .filter(Boolean);
  if (jsdoc.length) {
    const primary = jsdoc.filter((doc) => doc.documented).at(-1) || jsdoc.at(-1);
    const category = jsdoc
      .map((doc) => doc.category)
      .filter(Boolean)
      .at(-1);
    return { ...primary, category: primary.category || category || null };
  }

  return null;
}

function propertyName(node) {
  if (!node) return "unknown";
  if (node.type === "Identifier" || node.type === "PrivateName") return node.name || node.id?.name;
  if (node.type === "StringLiteral" || node.type === "NumericLiteral") return String(node.value);
  return "computed";
}

function classNameFromFile(filePath) {
  return path
    .basename(filePath, ".js")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function parameterName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "AssignmentPattern") return parameterName(node.left);
  if (node.type === "RestElement") return parameterName(node.argument);
  return null;
}

function astParameters(node, source) {
  return (node.params || []).map((parameter) => ({
    name: parameterName(parameter),
    source: source.slice(parameter.start, parameter.end),
    optional: parameter.type === "AssignmentPattern",
    rest: parameter.type === "RestElement",
    type: null,
    description: "",
    defaultValue:
      parameter.type === "AssignmentPattern"
        ? source.slice(parameter.right.start, parameter.right.end)
        : null,
  }));
}

function mergeParameters(ast, documented, { strict, context }) {
  if (
    ast.length === 1 &&
    ast[0].rest &&
    documented.some((parameter) => parameter.name.split(".")[0] !== ast[0].name)
  ) {
    const logical = [];
    for (const doc of documented) {
      const rootName = doc.name.split(".")[0];
      let target = logical.find((parameter) => parameter.name === rootName);
      if (doc.name === rootName) {
        target = { ...doc, source: doc.name, rest: Boolean(doc.type?.startsWith("...")) };
        logical.push(target);
      } else if (!target) {
        if (strict) {
          throw new Error(
            `Documented parameter "${doc.name}" has no root parameter on ${context}.`,
          );
        }
      } else {
        logical.push({ ...doc, source: doc.name, rest: false, nested: true });
      }
    }
    return logical;
  }

  const result = ast.map((parameter) => ({ ...parameter }));
  for (const doc of documented) {
    const rootName = doc.name.split(".")[0];
    let target = result.find((parameter) => parameter.name === rootName);
    if (!target && doc.name === rootName) {
      target = result.find((parameter) => parameter.name == null);
      if (target) target.name = rootName;
    }
    if (!target) {
      if (strict)
        throw new Error(`Documented parameter "${doc.name}" is not declared on ${context}.`);
      continue;
    }
    if (doc.name === rootName) {
      Object.assign(target, doc, { source: target.source, rest: target.rest });
    } else {
      result.push({
        ...doc,
        source: doc.name,
        rest: false,
        nested: true,
      });
    }
  }
  return result;
}

function signatureFor(node, source, className) {
  const params = (node.params || [])
    .map((parameter) => source.slice(parameter.start, parameter.end))
    .join(", ");
  if (node.kind === "constructor") return `new ${className}(${params})`;
  const name = propertyName(node.key);
  const prefix = node.static ? "." : "::";
  if (node.kind === "get") return `${prefix}${name}`;
  if (node.kind === "set") return `${prefix}${name} = value`;
  return `${prefix}${name}(${params})`;
}

function inferredVisibility(members) {
  for (const status of ["Essential", "Public", "Extended", "Experimental"]) {
    if (members.some((member) => member.visibility === status)) return status;
  }
  return "Public";
}

function constructorProperties(classNode, options) {
  const constructorNode = classNode.body.body.find(
    (member) => member.type === "ClassMethod" && member.kind === "constructor",
  );
  if (!constructorNode) return [];

  const properties = [];
  for (const statement of constructorNode.body.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const assignment = statement.expression;
    if (assignment.type !== "AssignmentExpression") continue;
    const target = assignment.left;
    if (
      target.type !== "MemberExpression" ||
      target.object.type !== "ThisExpression" ||
      target.computed ||
      target.property.type !== "Identifier"
    ) {
      continue;
    }
    const context = `${options.className}#${target.property.name}`;
    const doc = parseDoc(adjacentComments(statement), { ...options, context });
    if (!doc?.documented) continue;
    const description =
      doc.description ||
      (doc.propertyType
        ? `${indefiniteArticle(doc.propertyType)} {@link ${doc.propertyType}} instance`
        : "");
    properties.push({
      name: target.property.name,
      kind: "property",
      static: false,
      async: false,
      signature: `::${target.property.name}`,
      category: doc.category || "Properties",
      visibility: doc.visibility,
      description,
      summary: firstParagraph(description),
      parameters: [],
      returnType: null,
      returnDescription: "",
      propertyType: doc.propertyType,
      line: statement.loc.start.line,
    });
  }
  return properties.sort((left, right) => left.name.localeCompare(right.name));
}

function parseFile(filePath, sourceInput, options) {
  const source = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  let ast;
  try {
    ast = options.parser.parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: [
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "classStaticBlock",
        "jsx",
        "logicalAssignment",
        "nullishCoalescingOperator",
        "numericSeparator",
        "objectRestSpread",
        "optionalCatchBinding",
        "optionalChaining",
      ],
    });
  } catch (error) {
    throw new Error(`Unable to parse ${filePath}: ${error.message}`, { cause: error });
  }
  if (ast.errors?.length) {
    throw new Error(`Unable to parse ${filePath}: ${ast.errors[0].message}`);
  }

  const classes = [];
  const functions = [];
  visit(ast, [], (node, parent, ancestors) => {
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      const name = node.id?.name || classNameFromFile(filePath);
      const own = commentText(ownComments(node, ancestors));
      const doc = parseDoc(commentsFor(node, ancestors), {
        ...options,
        context: name,
      });
      if (!doc && /(?:^|\n)Private:|(?:^|\n)@private\b/.test(own)) return;
      const classDoc = doc?.documented ? doc : null;

      const members = [];
      let category = "Methods";
      for (const member of node.body.body) {
        if (!["ClassMethod", "ClassPrivateMethod"].includes(member.type)) continue;
        const memberName = member.kind === "constructor" ? "constructor" : propertyName(member.key);
        const context = `${name}${member.static ? "." : "#"}${memberName}`;
        const memberDoc = parseDoc(member.leadingComments || [], { ...options, context });
        if (!memberDoc) continue;
        if (memberDoc.category) category = memberDoc.category;
        if (!memberDoc.documented) continue;
        const parameters = mergeParameters(astParameters(member, source), memberDoc.parameters, {
          strict: options.strict,
          context,
        });
        members.push({
          name: memberName,
          kind: member.kind,
          static: Boolean(member.static),
          async: Boolean(member.async),
          signature: signatureFor(member, source, name),
          category,
          visibility: memberDoc.visibility,
          description: memberDoc.description,
          summary: memberDoc.summary,
          parameters,
          returnType: memberDoc.returns?.type || null,
          returnDescription: memberDoc.returns?.description || "",
          propertyType: memberDoc.propertyType,
          line: member.loc.start.line,
        });
      }

      members.unshift(...constructorProperties(node, { ...options, className: name }));
      if (!classDoc && !members.length) return;
      const memberNames = new Set();
      for (const member of members) {
        const memberKey = `${member.static ? "." : "#"}${member.name}`;
        if (memberNames.has(memberKey)) {
          throw new Error(`Duplicate documented member "${name}${memberKey}" in ${filePath}.`);
        }
        memberNames.add(memberKey);
      }
      classes.push({
        name,
        visibility: classDoc?.visibility || inferredVisibility(members),
        description: classDoc?.description || (isDirective(own) ? "" : own),
        summary: classDoc?.summary || firstParagraph(isDirective(own) ? "" : own),
        source: `${sourceInput.label}/${path.relative(sourceInput.root, filePath).replaceAll("\\", "/")}`,
        sourcePath: `src/${path.relative(sourceInput.root, filePath).replaceAll("\\", "/")}`,
        repository: sourceInput.repository,
        line: node.loc.start.line,
        members,
      });
    }

    if (node.type === "FunctionDeclaration" && parent?.type === "Program") {
      const context = node.id.name;
      const doc = parseDoc(node.leadingComments || [], { ...options, context });
      if (!doc?.documented) return;
      const parameters = mergeParameters(astParameters(node, source), doc.parameters, {
        strict: options.strict,
        context,
      });
      functions.push({
        name: node.id.name,
        signature: `${node.id.name}(${parameters.map((item) => item.source).join(", ")})`,
        visibility: doc.visibility,
        description: doc.description,
        summary: doc.summary,
        parameters,
        returnType: doc.returns?.type || null,
        returnDescription: doc.returns?.description || "",
        source: `${sourceInput.label}/${path.relative(sourceInput.root, filePath).replaceAll("\\", "/")}`,
        sourcePath: `src/${path.relative(sourceInput.root, filePath).replaceAll("\\", "/")}`,
        repository: sourceInput.repository,
        line: node.loc.start.line,
      });
    }
  });
  return { classes, functions };
}

function uniqueByName(items, kind) {
  const seen = new Map();
  for (const item of items) {
    const previous = seen.get(item.name);
    if (previous) {
      throw new Error(
        `Duplicate documented ${kind} "${item.name}" in ${previous.sourcePath} and ${item.sourcePath}.`,
      );
    }
    seen.set(item.name, item);
  }
  return [...seen.values()];
}

function compareClasses(left, right) {
  if (left.name === "LumineEnvironment") return -1;
  if (right.name === "LumineEnvironment") return 1;
  return left.name.localeCompare(right.name);
}

function documentationEntries(classes, functions) {
  return [
    ...classes.flatMap((cls) => [
      { context: cls.name, className: cls.name, text: cls.description },
      ...cls.members.flatMap((member) => [
        {
          context: `${cls.name}${member.static ? "." : "#"}${member.name}`,
          className: cls.name,
          text: member.description,
        },
        ...member.parameters.map((parameter) => ({
          context: `${cls.name}${member.static ? "." : "#"}${member.name} parameter ${parameter.name}`,
          className: cls.name,
          text: parameter.description,
        })),
        {
          context: `${cls.name}${member.static ? "." : "#"}${member.name} return value`,
          className: cls.name,
          text: member.returnDescription,
        },
      ]),
    ]),
    ...functions.flatMap((fn) => [
      { context: fn.name, className: null, text: fn.description },
      ...fn.parameters.map((parameter) => ({
        context: `${fn.name} parameter ${parameter.name}`,
        className: null,
        text: parameter.description,
      })),
      {
        context: `${fn.name} return value`,
        className: null,
        text: fn.returnDescription,
      },
    ]),
  ];
}

function validateLinks(classes, functions) {
  const membersByClass = new Map(
    classes.map((cls) => [cls.name, new Set(cls.members.map((member) => member.name))]),
  );
  const functionsByName = new Set(functions.map((fn) => fn.name));
  for (const entry of documentationEntries(classes, functions)) {
    for (const match of entry.text.matchAll(/\{@link\s+([^}\s]+)(?:\s+[^}]*)?\}/g)) {
      const target = match[1].split("|", 1)[0];
      if (/^(?:https?:|mailto:)/.test(target)) continue;
      let resolved;
      if (target.startsWith("#") || target.startsWith(".")) {
        resolved = Boolean(
          entry.className && membersByClass.get(entry.className)?.has(target.slice(1)),
        );
      } else {
        const memberTarget = target.match(/^([^#.]+)([#.])(.+)$/);
        resolved = memberTarget
          ? Boolean(membersByClass.get(memberTarget[1])?.has(memberTarget[3]))
          : membersByClass.has(target) || functionsByName.has(target);
      }
      if (!resolved) {
        throw new Error(`Unresolved JSDoc link "${target}" on ${entry.context}.`);
      }
    }
  }
}

function extractApi({ editorRoot, parser, strict = true }) {
  if (!editorRoot) throw new Error("extractApi requires editorRoot.");
  if (!parser?.parse) throw new Error("extractApi requires a parser with a parse() method.");
  const resolvedRoot = path.resolve(editorRoot);
  const sourceRoot = path.join(resolvedRoot, "src");
  if (!fs.existsSync(sourceRoot)) throw new Error(`API source does not exist: ${sourceRoot}`);
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(resolvedRoot, "package.json"), "utf8"),
  );
  const repository =
    typeof packageMetadata.repository === "string"
      ? packageMetadata.repository
      : packageMetadata.repository?.url;
  const sourceInput = {
    root: sourceRoot,
    label: "src",
    repository: (repository || "https://github.com/lumine-code/lumine").replace(/\.git$/, ""),
  };
  const parsed = walk(sourceRoot).map((filePath) =>
    parseFile(filePath, sourceInput, { parser, strict }),
  );
  const classes = uniqueByName(
    parsed.flatMap((item) => item.classes),
    "class",
  ).sort(compareClasses);
  if (classes[0]?.name !== "LumineEnvironment") {
    throw new Error("LumineEnvironment must be the first generated API class.");
  }
  const functions = uniqueByName(
    parsed.flatMap((item) => item.functions),
    "function",
  ).sort((left, right) => left.name.localeCompare(right.name));
  if (strict) validateLinks(classes, functions);
  return {
    schemaVersion: SCHEMA_VERSION,
    name: packageMetadata.productName || packageMetadata.name,
    version: packageMetadata.version,
    classes,
    functions,
    memberCount: classes.reduce((count, item) => count + item.members.length, 0) + functions.length,
  };
}

module.exports = { API_STATUSES, SCHEMA_VERSION, extractApi };
