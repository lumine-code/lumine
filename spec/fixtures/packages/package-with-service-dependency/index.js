let dependency;

module.exports = {
  activate() {
    dependency = null;
  },

  consumeDependency(service) {
    dependency = service;
  },

  provideDependentService() {
    return dependency;
  },
};
