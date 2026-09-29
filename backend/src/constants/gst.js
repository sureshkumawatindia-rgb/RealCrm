// GST state codes (the first two digits of a GSTIN), from the GST portal's list.
// 25 (Daman and Diu) was merged into 26 in 2020; 97 = Other Territory; 99 = Other Country.
// ut: Union Territories without a legislature charge UTGST instead of SGST.
const GST_STATES = Object.freeze([
  { code: '01', name: 'Jammu and Kashmir' },
  { code: '02', name: 'Himachal Pradesh' },
  { code: '03', name: 'Punjab' },
  { code: '04', name: 'Chandigarh', ut: true },
  { code: '05', name: 'Uttarakhand' },
  { code: '06', name: 'Haryana' },
  { code: '07', name: 'Delhi' },
  { code: '08', name: 'Rajasthan' },
  { code: '09', name: 'Uttar Pradesh' },
  { code: '10', name: 'Bihar' },
  { code: '11', name: 'Sikkim' },
  { code: '12', name: 'Arunachal Pradesh' },
  { code: '13', name: 'Nagaland' },
  { code: '14', name: 'Manipur' },
  { code: '15', name: 'Mizoram' },
  { code: '16', name: 'Tripura' },
  { code: '17', name: 'Meghalaya' },
  { code: '18', name: 'Assam' },
  { code: '19', name: 'West Bengal' },
  { code: '20', name: 'Jharkhand' },
  { code: '21', name: 'Odisha' },
  { code: '22', name: 'Chhattisgarh' },
  { code: '23', name: 'Madhya Pradesh' },
  { code: '24', name: 'Gujarat' },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', ut: true },
  { code: '27', name: 'Maharashtra' },
  { code: '29', name: 'Karnataka' },
  { code: '30', name: 'Goa' },
  { code: '31', name: 'Lakshadweep', ut: true },
  { code: '32', name: 'Kerala' },
  { code: '33', name: 'Tamil Nadu' },
  { code: '34', name: 'Puducherry' },
  { code: '35', name: 'Andaman and Nicobar Islands', ut: true },
  { code: '36', name: 'Telangana' },
  { code: '37', name: 'Andhra Pradesh' },
  { code: '38', name: 'Ladakh', ut: true },
  { code: '97', name: 'Other Territory' },
  { code: '99', name: 'Other Country' },
]);

const BY_CODE = new Map(GST_STATES.map((state) => [state.code, state]));
const simplify = (value) => String(value || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
// Other spellings people type in addresses.
const ALIASES = {
  orissa: '21', jk: '01', jandk: '01', newdelhi: '07', nctofdelhi: '07', delhinct: '07', pondicherry: '34',
  uttaranchal: '05', andaman: '35', andamanandnicobar: '35', damananddiu: '26', dadraandnagarhaveli: '26', dnhanddd: '26', up: '09', mp: '23',
};
const BY_NAME = new Map([...GST_STATES.map((state) => [simplify(state.name), state.code]), ...Object.entries(ALIASES)]);

// "08", "8", "Rajasthan", "rajasthan " → "08"; unknown → "".
function stateCodeFor(value) {
  const text = String(value || '').trim();
  if (/^\d{1,2}$/.test(text)) {
    const code = text.padStart(2, '0');
    return code === '25' ? '26' : BY_CODE.has(code) ? code : '';
  }
  return BY_NAME.get(simplify(text)) || '';
}

const stateName = (code) => BY_CODE.get(code)?.name || '';
const isUnionTerritory = (code) => Boolean(BY_CODE.get(code)?.ut);

module.exports = { GST_STATES, stateCodeFor, stateName, isUnionTerritory };
