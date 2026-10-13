import { Point } from "lumine";

export default function () {
  const done = this.async();
  import("node:path").then(({ basename }) => {
    done({ name: basename("/native/task"), position: new Point(2, 3).serialize() });
  });
}
