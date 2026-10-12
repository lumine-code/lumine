function copyableElement(tagName = "div") {
  const decorate = (element) => {
    element.copy = () => decorate(element.cloneNode(true));
    return element;
  };
  return decorate(document.createElement(tagName));
}

module.exports = { copyableElement };
