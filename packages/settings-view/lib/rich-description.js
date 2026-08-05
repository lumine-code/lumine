module.exports = {
  getSettingDescription(keyPath) {
    const schema = atom.config.getSchema(keyPath);
    let description = "";
    if (schema && schema.description) {
      description = schema.description;
    }

    const html = atom.tools.markdown
      .render(description, {
        useTaskCheckbox: false,
        disableMode: "strict",
      })
      .trim();

    // A description that renders to a single paragraph is unwrapped so it sits
    // inline in the description element. One that renders to several keeps its
    // `<p>` wrappers — unwrapping only the first would rob it of the margin
    // that separates it from the next.
    const singleParagraph = /^<p>([\s\S]*)<\/p>$/.exec(html);
    if (singleParagraph && !singleParagraph[1].includes("<p>")) {
      return singleParagraph[1];
    }

    return html;
  },
};
