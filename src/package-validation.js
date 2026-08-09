"use strict";

const semver = require("semver");
const { normalizeRepositoryOrigin } = require("./package-source");

const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function repositoryValue(repository) {
  if (typeof repository === "string") return repository;
  if (repository && typeof repository.url === "string") return repository.url;
  return "";
}

function validatePackageMetadata(
  metadata,
  { originKey, semanticTag = null, lumineVersion = null, allowIncompatible = false } = {},
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Package manifest must contain an object.");
  }
  if (typeof metadata.name !== "string" || !PACKAGE_NAME_PATTERN.test(metadata.name)) {
    throw new Error(
      "Package manifest must contain an unscoped lowercase name safe for an installation folder.",
    );
  }

  const repository = repositoryValue(metadata.repository);
  if (!repository) {
    throw new Error('A package manifest must contain a Git "repository".');
  }
  const manifestOrigin = normalizeRepositoryOrigin(repository);
  if (!manifestOrigin || !originKey || manifestOrigin !== originKey) {
    throw new Error(
      `Package repository origin "${manifestOrigin || repository}" does not match install origin "${originKey || "unknown"}".`,
    );
  }

  const engine = metadata.engines && metadata.engines.lumine;
  if (typeof engine !== "string" || !semver.validRange(engine)) {
    throw new Error('Package manifest must contain a valid "engines.lumine" range.');
  }
  // An engine mismatch is a soft state during catalog hydration: the package is
  // still shown (with its Install action disabled and switchable to another ref)
  // rather than rejected. Installs and update checks pass this strictly.
  if (
    !allowIncompatible &&
    lumineVersion &&
    semver.valid(lumineVersion) &&
    !semver.satisfies(lumineVersion, engine)
  ) {
    throw new Error(`Package requires Lumine ${engine}, but this version is ${lumineVersion}.`);
  }

  if (semanticTag) {
    const tagVersion = semver.valid(semanticTag);
    if (
      tagVersion &&
      (!semver.valid(metadata.version) || !semver.eq(tagVersion, metadata.version))
    ) {
      throw new Error(
        `Tag "${semanticTag}" does not match package version "${metadata.version || "missing"}".`,
      );
    }
  }

  return {
    ...metadata,
    repository,
    originKey,
    theme: metadata.theme === "ui" || metadata.theme === "syntax" ? metadata.theme : false,
    description: typeof metadata.description === "string" ? metadata.description : "",
    keywords: Array.isArray(metadata.keywords)
      ? metadata.keywords.filter((keyword) => typeof keyword === "string").slice(0, 25)
      : [],
  };
}

module.exports = {
  PACKAGE_NAME_PATTERN,
  repositoryValue,
  validatePackageMetadata,
};
