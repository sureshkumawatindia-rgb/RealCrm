/**
 * legal.js — privacy.html and terms.html (D60): fills in who runs this CRM (name, email,
 * address) from /api/v1/site, the details printed on the plan invoices.
 */
(function legalPage() {
  crmApi("/site").then((site) => {
    document.querySelectorAll(".js-operator-name").forEach((el) => {
      el.textContent = site.name;
    });
    if (site.address) {
      document.querySelectorAll(".js-operator-address").forEach((el) => {
        el.textContent = `, ${site.address}`;
      });
    }
    if (site.email) {
      document.querySelectorAll(".js-operator-email").forEach((el) => {
        el.textContent = site.email;
        el.href = `mailto:${site.email}`;
      });
    }
  }).catch(() => {
    /* the page reads well without them */
  });
})();
