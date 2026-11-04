module.exports = ({ before, oldText, newText }) =>
  /\S/.test(before) && /^[A-Za-z0-9_ ]*$/.test(oldText + newText);
