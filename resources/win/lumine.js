var path = require("path");
var spawn = require("child_process").spawn;

var lumineCommandPath = path.resolve(__dirname, "..", process.argv[2]);
var args = process.argv.slice(3);
args.unshift("--executed-from", process.cwd());
var options = { detached: true, stdio: "ignore" };
spawn(lumineCommandPath, args, options);
process.exit(0);
