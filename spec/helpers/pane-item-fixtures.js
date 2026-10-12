function copyableElement(tagName = "div", locations = ["center"]) {
  const decorate = (element) => {
    element.copy = () => decorate(element.cloneNode(true));
    element.getAllowedLocations = () => locations;
    return element;
  };
  return decorate(document.createElement(tagName));
}

module.exports = { copyableElement };
