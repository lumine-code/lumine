describe('"lumine" protocol URL', () => {
  it("sends the file relative in the package as response", (done) => {
    const request = new XMLHttpRequest();
    request.addEventListener("load", () => {
      done();
    });
    request.open("GET", "lumine://async/package.json", true);
    request.send();
  });
});
