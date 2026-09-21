'use strict'

module.exports = {
  initialize () {},

  activate () {
    if (this.createViewDuringActivation) {
      this.viewCreatedDuringActivation = lumine.views.getView({worksWithViewProvider1: true})
    }
  },

  theDeserializerMethod (state) {
    return {state: state}
  },

  viewProviderMethod1 (model) {
    if (model.worksWithViewProvider1) {
      let element = document.createElement('div')
      element.dataset['createdBy'] = 'view-provider-1'
      return element
    }
  },

  viewProviderMethod2 (model) {
    if (model.worksWithViewProvider2) {
      let element = document.createElement('div')
      element.dataset['createdBy'] = 'view-provider-2'
      return element
    }
  },

  deactivate () {}
}
