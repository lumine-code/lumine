// `<>…</>` resolves to etch.Fragment without any pragma.
const etch = require("@lumine-code/etch");

module.exports = (
  <div>
    <>
      <span>one</span>
      <span>two</span>
    </>
  </div>
);
