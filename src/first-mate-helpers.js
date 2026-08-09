module.exports = {
  fromFirstMateScopeId(firstMateScopeId) {
    let lumineScopeId = -firstMateScopeId;
    if ((lumineScopeId & 1) === 0) lumineScopeId--;
    return lumineScopeId + 256;
  },

  toFirstMateScopeId(lumineScopeId) {
    return -(lumineScopeId - 256);
  },
};
