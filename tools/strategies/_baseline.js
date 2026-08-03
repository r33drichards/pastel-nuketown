'use strict';
/* The policy currently in the userscript. Written once, by the tournament, so
   the field always contains the thing a challenger has to beat. */
const { userscript, policySource } = require('../eval-policy.js');
module.exports = {
  name: 'shipped',
  describe: 'the tuned reactive policy in the userscript',
  policySource: () => policySource(userscript())
};
