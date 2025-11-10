import { g as getDefaultExportFromCjs } from './_commonjsHelpers_BFTU3MAI.mjs';
import { r as requireTokenUtil } from './token-util_8GTOk-OQ.mjs';

function _mergeNamespaces(n, m) {
	for (var i = 0; i < m.length; i++) {
		const e = m[i];
		if (typeof e !== 'string' && !Array.isArray(e)) { for (const k in e) {
			if (k !== 'default' && !(k in n)) {
				const d = Object.getOwnPropertyDescriptor(e, k);
				if (d) {
					Object.defineProperty(n, k, d.get ? d : {
						enumerable: true,
						get: () => e[k]
					});
				}
			}
		} }
	}
	return Object.freeze(Object.defineProperty(n, Symbol.toStringTag, { value: 'Module' }));
}

var tokenUtilExports = requireTokenUtil();
const tokenUtil = /*@__PURE__*/getDefaultExportFromCjs(tokenUtilExports);

const tokenUtil$1 = /*#__PURE__*/_mergeNamespaces({
	__proto__: null,
	default: tokenUtil
}, [tokenUtilExports]);

export { tokenUtil$1 as t };
