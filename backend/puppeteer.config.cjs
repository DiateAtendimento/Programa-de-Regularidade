/** @type {import('puppeteer').Configuration} */
module.exports = {
  defaultProduct: 'chrome',
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR || '/opt/render/.cache/puppeteer'
};
