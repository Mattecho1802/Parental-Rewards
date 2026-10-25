// Fills in the app name, contact email and operator on the Privacy, Terms and Support pages
// from config.js, so you only ever change them in one place.
(function () {
  var c = window.APP_CONFIG || {};
  var name = c.appName || 'HappyHome';
  var who = c.operatorName || 'the operator of ' + name;
  document.querySelectorAll('[data-app-name]').forEach(function (el) { el.textContent = name; });
  document.querySelectorAll('[data-operator]').forEach(function (el) { el.textContent = who; });
  document.title = document.title.replace('{app}', name);
  document.querySelectorAll('[data-contact]').forEach(function (el) {
    if (c.contactEmail) {
      var a = document.createElement('a');
      a.href = 'mailto:' + c.contactEmail;
      a.textContent = c.contactEmail;
      el.replaceChildren(a);
    } else {
      el.textContent = 'the contact address shown in the app (it has not been set up yet)';
    }
  });
})();
