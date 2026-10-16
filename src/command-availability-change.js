// Local state only changes commands dispatched from that subtree. Registration
// changes and domain-wide invalidations have no target and affect every surface.
module.exports = function commandAvailabilityChangeAffectsTarget(change, target) {
  return (
    !change?.target ||
    !target ||
    change.target === target ||
    change.target.contains?.(target) === true
  );
};
