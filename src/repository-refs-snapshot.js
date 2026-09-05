const EMPTY_REFS_SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  generation: 0,
  initialized: false,
  head: null,
  branches: Object.freeze([]),
  remoteBranches: Object.freeze([]),
  tags: Object.freeze([]),
  remotes: Object.freeze([]),
  worktrees: Object.freeze([]),
});

const FOR_EACH_REF_FIELD_COUNT = 21;

function parseLastCommit({
  oid,
  peeledOid,
  parents,
  peeledParents,
  authorName,
  peeledAuthorName,
  committerDate,
  peeledCommitterDate,
  subject,
  peeledSubject,
}) {
  const usePeeledCommit = Boolean(peeledCommitterDate);
  const dateValue = usePeeledCommit ? peeledCommitterDate : committerDate;
  if (!dateValue) return null;

  const date = new Date(Number(dateValue) * 1000);
  if (Number.isNaN(date.getTime())) return null;

  const parentValue = usePeeledCommit ? peeledParents : parents;
  return Object.freeze({
    oid: usePeeledCommit ? peeledOid : oid,
    parents: Object.freeze(parentValue ? parentValue.split(" ") : []),
    authorName: (usePeeledCommit ? peeledAuthorName : authorName) || null,
    committerDate: date,
    subject: (usePeeledCommit ? peeledSubject : subject) || "",
  });
}

function parseUpstreamTrack(track) {
  if (track === "gone") return { ahead: 0, behind: 0, gone: true };
  const ahead = /(?:^|[ ,])ahead (\d+)/.exec(track);
  const behind = /(?:^|[ ,])behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: false,
  };
}

function shortRefName(ref) {
  const components = String(ref).split("/");
  return components.slice(2).join("/");
}

function parseUpstreamRefs(output) {
  const upstreams = new Map();
  for (const record of String(output).split("\n")) {
    if (!record) continue;
    const fields = record.split("\0");
    if (fields.length !== 4) throw new Error(`Invalid Git upstream record: ${record}`);
    const [ref, oid, upstreamRef, track] = fields;
    if (!upstreamRef) continue;
    upstreams.set(
      ref,
      Object.freeze({
        oid,
        value: Object.freeze({
          ref: upstreamRef,
          name: shortRefName(upstreamRef),
          ...parseUpstreamTrack(track),
        }),
      }),
    );
  }
  return upstreams;
}

function parsePushRefs(output) {
  const pushes = new Map();
  for (const record of String(output).split("\n")) {
    if (!record) continue;
    const fields = record.split("\0");
    if (fields.length !== 3) throw new Error(`Invalid Git push record: ${record}`);
    const [ref, oid, pushRef] = fields;
    if (!pushRef) continue;
    pushes.set(
      ref,
      Object.freeze({
        oid,
        value: Object.freeze({ ref: pushRef, name: shortRefName(pushRef) }),
      }),
    );
  }
  return pushes;
}

function parseTagObjects(output) {
  const tags = new Map();
  for (const record of String(output).split("\n")) {
    if (!record) continue;
    const fields = record.split("\t");
    if (fields.length !== 3) throw new Error(`Invalid Git tag object record: ${record}`);
    const [resolvedOid, objectType, label] = fields;
    const separator = label.indexOf(":");
    const kind = label.slice(0, separator);
    const inputOid = label.slice(separator + 1);
    if (separator === -1 || (kind !== "raw" && kind !== "peeled") || !inputOid) {
      throw new Error(`Invalid Git tag object label: ${label}`);
    }
    let detail = tags.get(inputOid);
    if (!detail) tags.set(inputOid, (detail = {}));
    if (kind === "raw") detail.objectType = objectType;
    else detail.peeledOid = resolvedOid;
  }
  return tags;
}

function parseCommitMetadata(output) {
  const commits = new Map();
  for (const record of String(output).split("\n")) {
    if (!record) continue;
    const fields = record.split("\0");
    if (fields.length !== 5) throw new Error(`Invalid Git commit metadata record: ${record}`);
    const [oid, parents, authorName, committerDate, subject] = fields;
    const date = new Date(Number(committerDate) * 1000);
    if (!oid || Number.isNaN(date.getTime())) continue;
    commits.set(
      oid,
      Object.freeze({
        oid,
        parents: Object.freeze(parents ? parents.split(" ") : []),
        authorName: authorName || null,
        committerDate: date,
        subject: subject || "",
      }),
    );
  }
  return commits;
}

function parseForEachRef(
  output,
  { tagObjects = "", commitMetadata = "", upstreamRefs = "", pushRefs = "" } = {},
) {
  const branches = [];
  const remoteBranches = [];
  const tags = [];
  const detailsByTagObject = parseTagObjects(tagObjects);
  const commitsByOid = parseCommitMetadata(commitMetadata);
  const upstreams = parseUpstreamRefs(upstreamRefs);
  const pushes = parsePushRefs(pushRefs);

  for (const record of String(output).split("\n")) {
    if (!record) continue;
    const fields = record.split("\0");
    if (fields.length !== FOR_EACH_REF_FIELD_COUNT) {
      throw new Error(`Invalid Git for-each-ref record: ${record}`);
    }
    const [
      ref,
      shortName,
      oid,
      objectType,
      peeledOid,
      upstreamRef,
      upstreamShort,
      upstreamTrack,
      pushRef,
      pushShort,
      ,
      headMarker,
      symref,
      parents = "",
      peeledParents = "",
      authorName = "",
      peeledAuthorName = "",
      committerDate = "",
      peeledCommitterDate = "",
      subject = "",
      peeledSubject = "",
    ] = fields;
    const tagDetail = detailsByTagObject.get(oid);
    const resolvedObjectType = tagDetail?.objectType || objectType;
    const resolvedPeeledOid = tagDetail?.peeledOid || peeledOid;
    const lastCommit =
      commitsByOid.get(resolvedPeeledOid || oid) ||
      parseLastCommit({
        oid,
        peeledOid: resolvedPeeledOid,
        parents,
        peeledParents,
        authorName,
        peeledAuthorName,
        committerDate,
        peeledCommitterDate,
        subject,
        peeledSubject,
      });

    if (ref.startsWith("refs/heads/")) {
      const auxiliaryUpstream = upstreams.get(ref);
      const upstream =
        (auxiliaryUpstream?.oid === oid ? auxiliaryUpstream.value : null) ||
        (upstreamRef
          ? Object.freeze({
              ref: upstreamRef,
              name: upstreamShort || shortRefName(upstreamRef),
              ...parseUpstreamTrack(upstreamTrack),
            })
          : null);
      const auxiliaryPush = pushes.get(ref);
      const push =
        (auxiliaryPush?.oid === oid ? auxiliaryPush.value : null) ||
        (pushRef
          ? Object.freeze({
              ref: pushRef,
              name: pushShort || shortRefName(pushRef),
            })
          : null);
      branches.push(
        Object.freeze({
          name: shortName || shortRefName(ref),
          ref,
          oid,
          isHead: headMarker === "*",
          upstream,
          push,
          lastCommit,
        }),
      );
    } else if (ref.startsWith("refs/remotes/")) {
      remoteBranches.push(
        Object.freeze({
          name: shortName || shortRefName(ref),
          ref,
          oid,
          remoteName: ref.split("/")[2],
          symrefTarget: symref || null,
          lastCommit,
        }),
      );
    } else if (ref.startsWith("refs/tags/")) {
      tags.push(
        Object.freeze({
          name: shortName || shortRefName(ref),
          ref,
          oid,
          targetOid: resolvedPeeledOid || oid,
          annotated: resolvedObjectType === "tag",
          lastCommit,
        }),
      );
    }
  }

  return { branches, remoteBranches, tags };
}

function parseRemotes(output) {
  const remotesByName = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^(\S+)\t(.*) \((fetch|push)\)$/.exec(line);
    if (!match) continue;
    let remote = remotesByName.get(match[1]);
    if (!remote) {
      remote = { name: match[1], fetchUrl: null, pushUrl: null };
      remotesByName.set(match[1], remote);
    }
    if (match[3] === "fetch") remote.fetchUrl = match[2];
    else remote.pushUrl = match[2];
  }
  return Array.from(remotesByName.values(), (remote) => Object.freeze(remote));
}

function parseWorktrees(output) {
  const worktrees = [];
  let current = null;

  const finish = () => {
    if (current) worktrees.push(Object.freeze(current));
    current = null;
  };

  for (const attribute of String(output).split("\0")) {
    if (attribute === "") {
      finish();
      continue;
    }
    if (attribute.startsWith("worktree ")) {
      finish();
      current = {
        path: attribute.slice("worktree ".length),
        headOid: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockedReason: null,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (attribute.startsWith("HEAD ")) current.headOid = attribute.slice(5);
    else if (attribute.startsWith("branch ")) current.branch = attribute.slice(7);
    else if (attribute === "detached") current.detached = true;
    else if (attribute === "bare") current.bare = true;
    else if (attribute === "locked") current.locked = true;
    else if (attribute.startsWith("locked ")) {
      current.locked = true;
      current.lockedReason = attribute.slice(7);
    } else if (attribute === "prunable" || attribute.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  finish();

  return worktrees;
}

function parseHead(symbolicHead, headOid) {
  const ref = String(symbolicHead || "").trim();
  const oid = String(headOid || "").trim();
  return Object.freeze({
    oid: oid || null,
    ref: ref || null,
    name: ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null,
    detached: !ref && Boolean(oid),
    unborn: !oid,
  });
}

function parseRefsSnapshot(
  {
    forEachRef,
    tagObjects,
    commitMetadata,
    upstreamRefs,
    pushRefs,
    remotes,
    worktrees,
    symbolicHead,
    headOid,
  },
  { generation = 1 } = {},
) {
  const refs = parseForEachRef(forEachRef, {
    tagObjects,
    commitMetadata,
    upstreamRefs,
    pushRefs,
  });
  return Object.freeze({
    schemaVersion: 1,
    generation,
    initialized: true,
    head: parseHead(symbolicHead, headOid),
    branches: Object.freeze(refs.branches),
    remoteBranches: Object.freeze(refs.remoteBranches),
    tags: Object.freeze(refs.tags),
    remotes: Object.freeze(parseRemotes(remotes)),
    worktrees: Object.freeze(parseWorktrees(worktrees)),
  });
}

module.exports = {
  EMPTY_REFS_SNAPSHOT,
  parseRefsSnapshot,
};
