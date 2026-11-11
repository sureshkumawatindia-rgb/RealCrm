// The CRM types a company can choose on its company form (Company Profile, Settings → Company).
// There is one CRM: a type only decides how that CRM is set up for the company's kind of work.
// "business" is the CRM as it always was, and what every company is until it chooses another.
// A new type goes here, as an <option> on company.html and Settings.html (crmTypes.test.js checks
// they stay the same), and in both i18n files as crmType.<id>. Its set-up is a file in
// crmTypeSetups/, its ready settings (stages, quick replies, terms) are KITS[<id>] in
// businessKits.js, and its words are in CRM_TYPE_WORDS in crm/frontend/js/app.js.
const pestControl = require('./crmTypeSetups/pestControl');
const trader = require('./crmTypeSetups/trader');
const manufacturer = require('./crmTypeSetups/manufacturer');
const realEstate = require('./crmTypeSetups/realEstate');
const education = require('./crmTypeSetups/education');
const clinic = require('./crmTypeSetups/clinic');
const travel = require('./crmTypeSetups/travel');
const insurance = require('./crmTypeSetups/insurance');
const salon = require('./crmTypeSetups/salon');
const gym = require('./crmTypeSetups/gym');
const interior = require('./crmTypeSetups/interior');
const solar = require('./crmTypeSetups/solar');

const CRM_TYPE_IDS = Object.freeze(['business', 'pest_control', 'trader', 'manufacturer', 'real_estate', 'education', 'clinic', 'travel', 'insurance', 'salon', 'gym', 'interior', 'solar']);
const DEFAULT_CRM_TYPE = 'business';
const CRM_TYPE_SETUPS = Object.freeze({ pest_control: pestControl, trader, manufacturer, real_estate: realEstate, education, clinic, travel, insurance, salon, gym, interior, solar });

module.exports = { CRM_TYPE_IDS, DEFAULT_CRM_TYPE, CRM_TYPE_SETUPS };
