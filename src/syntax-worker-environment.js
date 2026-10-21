function configuration(config) {
  return structuredClone({
    schema: config.schema,
    values: config.get(),
    scoped: config.getScopedSettingsStore().propertySets.map((entry) => ({
      source: entry.source,
      selector: entry.selector.toString(),
      properties: entry.properties,
      priority: entry.priority,
    })),
  });
}

function environment(grammars, version, { devMode = false, specMode = false } = {}) {
  return {
    version,
    devMode,
    specMode,
    configuration: configuration(grammars.config),
    grammars: grammars.getGrammars().map((grammar) => {
      if (grammar.definition.injectionPoints?.length)
        throw new Error(
          "Grammar definitions must register JavaScript injection points through a syntax module",
        );
      const { injectionPoints: _points, ...definition } = grammar.definition;
      return { file: grammar.grammarFilePath, definition: structuredClone(definition) };
    }),
    modules: [...grammars.syntaxModules.values()].map(({ id, path, method, args }) => ({
      id,
      path,
      method,
      args,
    })),
  };
}

module.exports = { configuration, environment };
