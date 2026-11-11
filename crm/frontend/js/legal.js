/**
 * legal.js — the legal pages: privacy, terms, refund, delivery and contact (D60). Fills in who
 * runs this CRM (name, address, email, GSTIN: the details printed on the plan invoices) and how to
 * reach support (WhatsApp, email, hours: set on the platform admin page) from /api/v1/site.
 * A line marked data-when-set stays hidden until its value is known.
 */
(function legalPage() {
  const fill = (selector, value, href) => {
    if (!value) return;
    document.querySelectorAll(selector).forEach((el) => {
      el.textContent = value;
      if (href) el.href = href;
      el.closest("[data-when-set]")?.removeAttribute("hidden");
    });
  };

  crmApi("/site").then((site) => {
    document.querySelectorAll(".js-operator-name").forEach((el) => {
      el.textContent = site.name;
    });
    if (site.address) {
      document.querySelectorAll(".js-operator-address").forEach((el) => {
        el.textContent = `, ${site.address}`;
      });
    }
    fill(".js-operator-address-line", site.address);
    fill(".js-operator-email", site.email, site.email && `mailto:${site.email}`);
    fill(".js-operator-gstin", site.gstin);
    const support = site.support || {};
    if (support.email && support.email !== site.email) fill(".js-support-email", support.email, `mailto:${support.email}`);
    fill(".js-support-phone", support.whatsapp, support.whatsapp && `tel:${support.whatsapp}`);
    if (support.whatsapp) {
      document.querySelectorAll(".js-support-whatsapp").forEach((el) => {
        el.href = `https://wa.me/${support.whatsapp.replace(/\D/g, "")}`;
      });
    }
    fill(".js-support-hours", support.hours);
  }).catch(() => {
    /* the page reads well without them */
  });

  if (document.querySelector(".js-trial-days")) {
    crmApi("/site/plans").then((plans) => fill(".js-trial-days", String(plans.trialDays))).catch(() => {});
  }
})();
