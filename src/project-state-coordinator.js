const crypto = require("crypto");
const { getProjectStateKey } = require("./project-state-keys");

module.exports = class ProjectStateCoordinator {
  constructor(getWindows) {
    this.getWindows = getWindows;
    this.reservationsById = new Map();
    this.reservationsByProjectKey = new Map();
  }

  reserve(window, projectPaths) {
    if (!window || window.isSpec) return { allowed: false, reservationId: null };

    const projectKey = getProjectStateKey(projectPaths);
    if (!projectKey) return { allowed: false, reservationId: null };

    const existingReservation = this.reservationsByProjectKey.get(projectKey);
    if (existingReservation && existingReservation.window !== window) {
      return { allowed: false, reservationId: null };
    }

    const hasOtherLiveWindow = this.getWindows().some((candidate) => {
      return (
        candidate !== window &&
        !candidate.isSpec &&
        getProjectStateKey(candidate.projectRoots) === projectKey
      );
    });
    if (hasOtherLiveWindow) return { allowed: false, reservationId: null };

    if (getProjectStateKey(window.projectRoots) === projectKey) {
      this.releaseWindow(window);
      return { allowed: true, reservationId: null };
    }

    if (existingReservation) {
      return { allowed: true, reservationId: existingReservation.id };
    }

    this.releaseWindow(window);
    const reservation = { id: crypto.randomUUID(), projectKey, window };
    this.reservationsById.set(reservation.id, reservation);
    this.reservationsByProjectKey.set(projectKey, reservation);
    return { allowed: true, reservationId: reservation.id };
  }

  commit(window, projectPaths) {
    const projectKey = getProjectStateKey(projectPaths);
    for (const reservation of this.reservationsById.values()) {
      if (reservation.window === window) {
        this.deleteReservation(reservation);
      }
    }
    return projectKey;
  }

  release(window, reservationId) {
    const reservation = this.reservationsById.get(reservationId);
    if (!reservation || reservation.window !== window) return false;
    this.deleteReservation(reservation);
    return true;
  }

  releaseWindow(window) {
    for (const reservation of Array.from(this.reservationsById.values())) {
      if (reservation.window === window) this.deleteReservation(reservation);
    }
  }

  deleteReservation(reservation) {
    this.reservationsById.delete(reservation.id);
    if (this.reservationsByProjectKey.get(reservation.projectKey) === reservation) {
      this.reservationsByProjectKey.delete(reservation.projectKey);
    }
  }
};
