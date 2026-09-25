'use strict';
const PERSONAS = { pl: require('./pl'), en: require('./en') };

const persona = (lang) => PERSONAS[lang] || PERSONAS.en;

module.exports = { PERSONAS, persona };
