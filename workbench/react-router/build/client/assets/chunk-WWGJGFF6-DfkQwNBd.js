function Da(e, t) {
  for (var r = 0; r < t.length; r++) {
    const n = t[r];
    if (typeof n != 'string' && !Array.isArray(n)) {
      for (const a in n)
        if (a !== 'default' && !(a in e)) {
          const o = Object.getOwnPropertyDescriptor(n, a);
          o &&
            Object.defineProperty(
              e,
              a,
              o.get ? o : { enumerable: !0, get: () => n[a] }
            );
        }
    }
  }
  return Object.freeze(
    Object.defineProperty(e, Symbol.toStringTag, { value: 'Module' })
  );
}
function _a(e) {
  return e && e.__esModule && Object.prototype.hasOwnProperty.call(e, 'default')
    ? e.default
    : e;
}
var Jt = { exports: {} },
  nt = {}; /**
 * @license React
 * react-jsx-runtime.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Wr;
function Oa() {
  if (Wr) return nt;
  Wr = 1;
  var e = Symbol.for('react.transitional.element'),
    t = Symbol.for('react.fragment');
  function r(n, a, o) {
    var i = null;
    if (
      (o !== void 0 && (i = '' + o),
      a.key !== void 0 && (i = '' + a.key),
      'key' in a)
    ) {
      o = {};
      for (var s in a) s !== 'key' && (o[s] = a[s]);
    } else o = a;
    return (
      (a = o.ref),
      { $$typeof: e, type: n, key: i, ref: a !== void 0 ? a : null, props: o }
    );
  }
  return (nt.Fragment = t), (nt.jsx = r), (nt.jsxs = r), nt;
}
var Yr;
function Aa() {
  return Yr || ((Yr = 1), (Jt.exports = Oa())), Jt.exports;
}
var Kl = Aa(),
  Gt = { exports: {} },
  z = {}; /**
 * @license React
 * react.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */
var Vr;
function Na() {
  if (Vr) return z;
  Vr = 1;
  var e = Symbol.for('react.transitional.element'),
    t = Symbol.for('react.portal'),
    r = Symbol.for('react.fragment'),
    n = Symbol.for('react.strict_mode'),
    a = Symbol.for('react.profiler'),
    o = Symbol.for('react.consumer'),
    i = Symbol.for('react.context'),
    s = Symbol.for('react.forward_ref'),
    l = Symbol.for('react.suspense'),
    u = Symbol.for('react.memo'),
    h = Symbol.for('react.lazy'),
    c = Symbol.for('react.activity'),
    y = Symbol.iterator;
  function g(p) {
    return p === null || typeof p != 'object'
      ? null
      : ((p = (y && p[y]) || p['@@iterator']),
        typeof p == 'function' ? p : null);
  }
  var E = {
      isMounted: function () {
        return !1;
      },
      enqueueForceUpdate: function () {},
      enqueueReplaceState: function () {},
      enqueueSetState: function () {},
    },
    L = Object.assign,
    R = {};
  function x(p, S, I) {
    (this.props = p),
      (this.context = S),
      (this.refs = R),
      (this.updater = I || E);
  }
  (x.prototype.isReactComponent = {}),
    (x.prototype.setState = function (p, S) {
      if (typeof p != 'object' && typeof p != 'function' && p != null)
        throw Error(
          'takes an object of state variables to update or a function which returns an object of state variables.'
        );
      this.updater.enqueueSetState(this, p, S, 'setState');
    }),
    (x.prototype.forceUpdate = function (p) {
      this.updater.enqueueForceUpdate(this, p, 'forceUpdate');
    });
  function b() {}
  b.prototype = x.prototype;
  function T(p, S, I) {
    (this.props = p),
      (this.context = S),
      (this.refs = R),
      (this.updater = I || E);
  }
  var M = (T.prototype = new b());
  (M.constructor = T), L(M, x.prototype), (M.isPureReactComponent = !0);
  var D = Array.isArray;
  function k() {}
  var m = { H: null, A: null, T: null, S: null },
    B = Object.prototype.hasOwnProperty;
  function W(p, S, I) {
    var H = I.ref;
    return {
      $$typeof: e,
      type: p,
      key: S,
      ref: H !== void 0 ? H : null,
      props: I,
    };
  }
  function G(p, S) {
    return W(p.type, S, p.props);
  }
  function U(p) {
    return typeof p == 'object' && p !== null && p.$$typeof === e;
  }
  function se(p) {
    var S = { '=': '=0', ':': '=2' };
    return (
      '$' +
      p.replace(/[=:]/g, function (I) {
        return S[I];
      })
    );
  }
  var Z = /\/+/g;
  function q(p, S) {
    return typeof p == 'object' && p !== null && p.key != null
      ? se('' + p.key)
      : S.toString(36);
  }
  function ne(p) {
    switch (p.status) {
      case 'fulfilled':
        return p.value;
      case 'rejected':
        throw p.reason;
      default:
        switch (
          (typeof p.status == 'string'
            ? p.then(k, k)
            : ((p.status = 'pending'),
              p.then(
                function (S) {
                  p.status === 'pending' &&
                    ((p.status = 'fulfilled'), (p.value = S));
                },
                function (S) {
                  p.status === 'pending' &&
                    ((p.status = 'rejected'), (p.reason = S));
                }
              )),
          p.status)
        ) {
          case 'fulfilled':
            return p.value;
          case 'rejected':
            throw p.reason;
        }
    }
    throw p;
  }
  function te(p, S, I, H, Y) {
    var J = typeof p;
    (J === 'undefined' || J === 'boolean') && (p = null);
    var Q = !1;
    if (p === null) Q = !0;
    else
      switch (J) {
        case 'bigint':
        case 'string':
        case 'number':
          Q = !0;
          break;
        case 'object':
          switch (p.$$typeof) {
            case e:
            case t:
              Q = !0;
              break;
            case h:
              return (Q = p._init), te(Q(p._payload), S, I, H, Y);
          }
      }
    if (Q)
      return (
        (Y = Y(p)),
        (Q = H === '' ? '.' + q(p, 0) : H),
        D(Y)
          ? ((I = ''),
            Q != null && (I = Q.replace(Z, '$&/') + '/'),
            te(Y, S, I, '', function (zt) {
              return zt;
            }))
          : Y != null &&
            (U(Y) &&
              (Y = G(
                Y,
                I +
                  (Y.key == null || (p && p.key === Y.key)
                    ? ''
                    : ('' + Y.key).replace(Z, '$&/') + '/') +
                  Q
              )),
            S.push(Y)),
        1
      );
    Q = 0;
    var he = H === '' ? '.' : H + ':';
    if (D(p))
      for (var me = 0; me < p.length; me++)
        (H = p[me]), (J = he + q(H, me)), (Q += te(H, S, I, J, Y));
    else if (((me = g(p)), typeof me == 'function'))
      for (p = me.call(p), me = 0; !(H = p.next()).done; )
        (H = H.value), (J = he + q(H, me++)), (Q += te(H, S, I, J, Y));
    else if (J === 'object') {
      if (typeof p.then == 'function') return te(ne(p), S, I, H, Y);
      throw (
        ((S = String(p)),
        Error(
          'Objects are not valid as a React child (found: ' +
            (S === '[object Object]'
              ? 'object with keys {' + Object.keys(p).join(', ') + '}'
              : S) +
            '). If you meant to render a collection of children, use an array instead.'
        ))
      );
    }
    return Q;
  }
  function ue(p, S, I) {
    if (p == null) return p;
    var H = [],
      Y = 0;
    return (
      te(p, H, '', '', function (J) {
        return S.call(I, J, Y++);
      }),
      H
    );
  }
  function ee(p) {
    if (p._status === -1) {
      var S = p._result;
      (S = S()),
        S.then(
          function (I) {
            (p._status === 0 || p._status === -1) &&
              ((p._status = 1), (p._result = I));
          },
          function (I) {
            (p._status === 0 || p._status === -1) &&
              ((p._status = 2), (p._result = I));
          }
        ),
        p._status === -1 && ((p._status = 0), (p._result = S));
    }
    if (p._status === 1) return p._result.default;
    throw p._result;
  }
  var fe =
      typeof reportError == 'function'
        ? reportError
        : function (p) {
            if (
              typeof window == 'object' &&
              typeof window.ErrorEvent == 'function'
            ) {
              var S = new window.ErrorEvent('error', {
                bubbles: !0,
                cancelable: !0,
                message:
                  typeof p == 'object' &&
                  p !== null &&
                  typeof p.message == 'string'
                    ? String(p.message)
                    : String(p),
                error: p,
              });
              if (!window.dispatchEvent(S)) return;
            } else if (
              typeof process == 'object' &&
              typeof process.emit == 'function'
            ) {
              process.emit('uncaughtException', p);
              return;
            }
            console.error(p);
          },
    be = {
      map: ue,
      forEach: function (p, S, I) {
        ue(
          p,
          function () {
            S.apply(this, arguments);
          },
          I
        );
      },
      count: function (p) {
        var S = 0;
        return (
          ue(p, function () {
            S++;
          }),
          S
        );
      },
      toArray: function (p) {
        return (
          ue(p, function (S) {
            return S;
          }) || []
        );
      },
      only: function (p) {
        if (!U(p))
          throw Error(
            'React.Children.only expected to receive a single React element child.'
          );
        return p;
      },
    };
  return (
    (z.Activity = c),
    (z.Children = be),
    (z.Component = x),
    (z.Fragment = r),
    (z.Profiler = a),
    (z.PureComponent = T),
    (z.StrictMode = n),
    (z.Suspense = l),
    (z.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = m),
    (z.__COMPILER_RUNTIME = {
      __proto__: null,
      c: function (p) {
        return m.H.useMemoCache(p);
      },
    }),
    (z.cache = function (p) {
      return function () {
        return p.apply(null, arguments);
      };
    }),
    (z.cacheSignal = function () {
      return null;
    }),
    (z.cloneElement = function (p, S, I) {
      if (p == null)
        throw Error(
          'The argument must be a React element, but you passed ' + p + '.'
        );
      var H = L({}, p.props),
        Y = p.key;
      if (S != null)
        for (J in (S.key !== void 0 && (Y = '' + S.key), S))
          !B.call(S, J) ||
            J === 'key' ||
            J === '__self' ||
            J === '__source' ||
            (J === 'ref' && S.ref === void 0) ||
            (H[J] = S[J]);
      var J = arguments.length - 2;
      if (J === 1) H.children = I;
      else if (1 < J) {
        for (var Q = Array(J), he = 0; he < J; he++) Q[he] = arguments[he + 2];
        H.children = Q;
      }
      return W(p.type, Y, H);
    }),
    (z.createContext = function (p) {
      return (
        (p = {
          $$typeof: i,
          _currentValue: p,
          _currentValue2: p,
          _threadCount: 0,
          Provider: null,
          Consumer: null,
        }),
        (p.Provider = p),
        (p.Consumer = { $$typeof: o, _context: p }),
        p
      );
    }),
    (z.createElement = function (p, S, I) {
      var H,
        Y = {},
        J = null;
      if (S != null)
        for (H in (S.key !== void 0 && (J = '' + S.key), S))
          B.call(S, H) &&
            H !== 'key' &&
            H !== '__self' &&
            H !== '__source' &&
            (Y[H] = S[H]);
      var Q = arguments.length - 2;
      if (Q === 1) Y.children = I;
      else if (1 < Q) {
        for (var he = Array(Q), me = 0; me < Q; me++)
          he[me] = arguments[me + 2];
        Y.children = he;
      }
      if (p && p.defaultProps)
        for (H in ((Q = p.defaultProps), Q)) Y[H] === void 0 && (Y[H] = Q[H]);
      return W(p, J, Y);
    }),
    (z.createRef = function () {
      return { current: null };
    }),
    (z.forwardRef = function (p) {
      return { $$typeof: s, render: p };
    }),
    (z.isValidElement = U),
    (z.lazy = function (p) {
      return { $$typeof: h, _payload: { _status: -1, _result: p }, _init: ee };
    }),
    (z.memo = function (p, S) {
      return { $$typeof: u, type: p, compare: S === void 0 ? null : S };
    }),
    (z.startTransition = function (p) {
      var S = m.T,
        I = {};
      m.T = I;
      try {
        var H = p(),
          Y = m.S;
        Y !== null && Y(I, H),
          typeof H == 'object' &&
            H !== null &&
            typeof H.then == 'function' &&
            H.then(k, fe);
      } catch (J) {
        fe(J);
      } finally {
        S !== null && I.types !== null && (S.types = I.types), (m.T = S);
      }
    }),
    (z.unstable_useCacheRefresh = function () {
      return m.H.useCacheRefresh();
    }),
    (z.use = function (p) {
      return m.H.use(p);
    }),
    (z.useActionState = function (p, S, I) {
      return m.H.useActionState(p, S, I);
    }),
    (z.useCallback = function (p, S) {
      return m.H.useCallback(p, S);
    }),
    (z.useContext = function (p) {
      return m.H.useContext(p);
    }),
    (z.useDebugValue = function () {}),
    (z.useDeferredValue = function (p, S) {
      return m.H.useDeferredValue(p, S);
    }),
    (z.useEffect = function (p, S) {
      return m.H.useEffect(p, S);
    }),
    (z.useEffectEvent = function (p) {
      return m.H.useEffectEvent(p);
    }),
    (z.useId = function () {
      return m.H.useId();
    }),
    (z.useImperativeHandle = function (p, S, I) {
      return m.H.useImperativeHandle(p, S, I);
    }),
    (z.useInsertionEffect = function (p, S) {
      return m.H.useInsertionEffect(p, S);
    }),
    (z.useLayoutEffect = function (p, S) {
      return m.H.useLayoutEffect(p, S);
    }),
    (z.useMemo = function (p, S) {
      return m.H.useMemo(p, S);
    }),
    (z.useOptimistic = function (p, S) {
      return m.H.useOptimistic(p, S);
    }),
    (z.useReducer = function (p, S, I) {
      return m.H.useReducer(p, S, I);
    }),
    (z.useRef = function (p) {
      return m.H.useRef(p);
    }),
    (z.useState = function (p) {
      return m.H.useState(p);
    }),
    (z.useSyncExternalStore = function (p, S, I) {
      return m.H.useSyncExternalStore(p, S, I);
    }),
    (z.useTransition = function () {
      return m.H.useTransition();
    }),
    (z.version = '19.2.0'),
    z
  );
}
var Jr;
function ka() {
  return Jr || ((Jr = 1), (Gt.exports = Na())), Gt.exports;
}
var f = ka();
const Ia = _a(f),
  $a = Da({ __proto__: null, default: Ia }, [f]); /**
 * react-router v7.10.1
 *
 * Copyright (c) Remix Software Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE.md file in the root directory of this source tree.
 *
 * @license MIT
 */
var Cn = (e) => {
    throw TypeError(e);
  },
  Fa = (e, t, r) => t.has(e) || Cn('Cannot ' + r),
  Xt = (e, t, r) => (
    Fa(e, t, 'read from private field'), r ? r.call(e) : t.get(e)
  ),
  ja = (e, t, r) =>
    t.has(e)
      ? Cn('Cannot add the same private member more than once')
      : t instanceof WeakSet
        ? t.add(e)
        : t.set(e, r),
  Gr = 'popstate';
function ql(e = {}) {
  function t(n, a) {
    let { pathname: o, search: i, hash: s } = n.location;
    return ut(
      '',
      { pathname: o, search: i, hash: s },
      (a.state && a.state.usr) || null,
      (a.state && a.state.key) || 'default'
    );
  }
  function r(n, a) {
    return typeof a == 'string' ? a : Pe(a);
  }
  return Ua(t, r, null, e);
}
function V(e, t) {
  if (e === !1 || e === null || typeof e > 'u') throw new Error(t);
}
function ie(e, t) {
  if (!e) {
    typeof console < 'u' && console.warn(t);
    try {
      throw new Error(t);
    } catch {}
  }
}
function Ha() {
  return Math.random().toString(36).substring(2, 10);
}
function Xr(e, t) {
  return { usr: e.state, key: e.key, idx: t };
}
function ut(e, t, r = null, n) {
  return {
    pathname: typeof e == 'string' ? e : e.pathname,
    search: '',
    hash: '',
    ...(typeof t == 'string' ? $e(t) : t),
    state: r,
    key: (t && t.key) || n || Ha(),
  };
}
function Pe({ pathname: e = '/', search: t = '', hash: r = '' }) {
  return (
    t && t !== '?' && (e += t.charAt(0) === '?' ? t : '?' + t),
    r && r !== '#' && (e += r.charAt(0) === '#' ? r : '#' + r),
    e
  );
}
function $e(e) {
  let t = {};
  if (e) {
    let r = e.indexOf('#');
    r >= 0 && ((t.hash = e.substring(r)), (e = e.substring(0, r)));
    let n = e.indexOf('?');
    n >= 0 && ((t.search = e.substring(n)), (e = e.substring(0, n))),
      e && (t.pathname = e);
  }
  return t;
}
function Ua(e, t, r, n = {}) {
  let { window: a = document.defaultView, v5Compat: o = !1 } = n,
    i = a.history,
    s = 'POP',
    l = null,
    u = h();
  u == null && ((u = 0), i.replaceState({ ...i.state, idx: u }, ''));
  function h() {
    return (i.state || { idx: null }).idx;
  }
  function c() {
    s = 'POP';
    let R = h(),
      x = R == null ? null : R - u;
    (u = R), l && l({ action: s, location: L.location, delta: x });
  }
  function y(R, x) {
    s = 'PUSH';
    let b = ut(L.location, R, x);
    u = h() + 1;
    let T = Xr(b, u),
      M = L.createHref(b);
    try {
      i.pushState(T, '', M);
    } catch (D) {
      if (D instanceof DOMException && D.name === 'DataCloneError') throw D;
      a.location.assign(M);
    }
    o && l && l({ action: s, location: L.location, delta: 1 });
  }
  function g(R, x) {
    s = 'REPLACE';
    let b = ut(L.location, R, x);
    u = h();
    let T = Xr(b, u),
      M = L.createHref(b);
    i.replaceState(T, '', M),
      o && l && l({ action: s, location: L.location, delta: 0 });
  }
  function E(R) {
    return Ln(R);
  }
  let L = {
    get action() {
      return s;
    },
    get location() {
      return e(a, i);
    },
    listen(R) {
      if (l) throw new Error('A history only accepts one active listener');
      return (
        a.addEventListener(Gr, c),
        (l = R),
        () => {
          a.removeEventListener(Gr, c), (l = null);
        }
      );
    },
    createHref(R) {
      return t(a, R);
    },
    createURL: E,
    encodeLocation(R) {
      let x = E(R);
      return { pathname: x.pathname, search: x.search, hash: x.hash };
    },
    push: y,
    replace: g,
    go(R) {
      return i.go(R);
    },
  };
  return L;
}
function Ln(e, t = !1) {
  let r = 'http://localhost';
  typeof window < 'u' &&
    (r =
      window.location.origin !== 'null'
        ? window.location.origin
        : window.location.href),
    V(r, 'No window.location.(origin|href) available to create URL');
  let n = typeof e == 'string' ? e : Pe(e);
  return (
    (n = n.replace(/ $/, '%20')),
    !t && n.startsWith('//') && (n = r + n),
    new URL(n, r)
  );
}
var lt,
  Kr = class {
    constructor(e) {
      if ((ja(this, lt, new Map()), e)) for (let [t, r] of e) this.set(t, r);
    }
    get(e) {
      if (Xt(this, lt).has(e)) return Xt(this, lt).get(e);
      if (e.defaultValue !== void 0) return e.defaultValue;
      throw new Error('No value found for context');
    }
    set(e, t) {
      Xt(this, lt).set(e, t);
    }
  };
lt = new WeakMap();
var za = new Set(['lazy', 'caseSensitive', 'path', 'id', 'index', 'children']);
function Ba(e) {
  return za.has(e);
}
var Wa = new Set([
  'lazy',
  'caseSensitive',
  'path',
  'id',
  'index',
  'middleware',
  'children',
]);
function Ya(e) {
  return Wa.has(e);
}
function Va(e) {
  return e.index === !0;
}
function ct(e, t, r = [], n = {}, a = !1) {
  return e.map((o, i) => {
    let s = [...r, String(i)],
      l = typeof o.id == 'string' ? o.id : s.join('-');
    if (
      (V(
        o.index !== !0 || !o.children,
        'Cannot specify children on an index route'
      ),
      V(
        a || !n[l],
        `Found a route id collision on id "${l}".  Route id's must be globally unique within Data Router usages`
      ),
      Va(o))
    ) {
      let u = { ...o, id: l };
      return (n[l] = qr(u, t(u))), u;
    } else {
      let u = { ...o, id: l, children: void 0 };
      return (
        (n[l] = qr(u, t(u))),
        o.children && (u.children = ct(o.children, t, s, n, a)),
        u
      );
    }
  });
}
function qr(e, t) {
  return Object.assign(e, {
    ...t,
    ...(typeof t.lazy == 'object' && t.lazy != null
      ? { lazy: { ...e.lazy, ...t.lazy } }
      : {}),
  });
}
function Ae(e, t, r = '/') {
  return st(e, t, r, !1);
}
function st(e, t, r, n) {
  let a = typeof t == 'string' ? $e(t) : t,
    o = Ee(a.pathname || '/', r);
  if (o == null) return null;
  let i = Mn(e);
  Ja(i);
  let s = null;
  for (let l = 0; s == null && l < i.length; ++l) {
    let u = no(o);
    s = ro(i[l], u, n);
  }
  return s;
}
function Pn(e, t) {
  let { route: r, pathname: n, params: a } = e;
  return {
    id: r.id,
    pathname: n,
    params: a,
    data: t[r.id],
    loaderData: t[r.id],
    handle: r.handle,
  };
}
function Mn(e, t = [], r = [], n = '', a = !1) {
  let o = (i, s, l = a, u) => {
    let h = {
      relativePath: u === void 0 ? i.path || '' : u,
      caseSensitive: i.caseSensitive === !0,
      childrenIndex: s,
      route: i,
    };
    if (h.relativePath.startsWith('/')) {
      if (!h.relativePath.startsWith(n) && l) return;
      V(
        h.relativePath.startsWith(n),
        `Absolute route path "${h.relativePath}" nested under path "${n}" is not valid. An absolute child route path must start with the combined path of all its parent routes.`
      ),
        (h.relativePath = h.relativePath.slice(n.length));
    }
    let c = Le([n, h.relativePath]),
      y = r.concat(h);
    i.children &&
      i.children.length > 0 &&
      (V(
        i.index !== !0,
        `Index routes must not have child routes. Please remove all child routes from route path "${c}".`
      ),
      Mn(i.children, t, y, c, l)),
      !(i.path == null && !i.index) &&
        t.push({ path: c, score: eo(c, i.index), routesMeta: y });
  };
  return (
    e.forEach((i, s) => {
      if (i.path === '' || !i.path?.includes('?')) o(i, s);
      else for (let l of Tn(i.path)) o(i, s, !0, l);
    }),
    t
  );
}
function Tn(e) {
  let t = e.split('/');
  if (t.length === 0) return [];
  let [r, ...n] = t,
    a = r.endsWith('?'),
    o = r.replace(/\?$/, '');
  if (n.length === 0) return a ? [o, ''] : [o];
  let i = Tn(n.join('/')),
    s = [];
  return (
    s.push(...i.map((l) => (l === '' ? o : [o, l].join('/')))),
    a && s.push(...i),
    s.map((l) => (e.startsWith('/') && l === '' ? '/' : l))
  );
}
function Ja(e) {
  e.sort((t, r) =>
    t.score !== r.score
      ? r.score - t.score
      : to(
          t.routesMeta.map((n) => n.childrenIndex),
          r.routesMeta.map((n) => n.childrenIndex)
        )
  );
}
var Ga = /^:[\w-]+$/,
  Xa = 3,
  Ka = 2,
  qa = 1,
  Qa = 10,
  Za = -2,
  Qr = (e) => e === '*';
function eo(e, t) {
  let r = e.split('/'),
    n = r.length;
  return (
    r.some(Qr) && (n += Za),
    t && (n += Ka),
    r
      .filter((a) => !Qr(a))
      .reduce((a, o) => a + (Ga.test(o) ? Xa : o === '' ? qa : Qa), n)
  );
}
function to(e, t) {
  return e.length === t.length && e.slice(0, -1).every((n, a) => n === t[a])
    ? e[e.length - 1] - t[t.length - 1]
    : 0;
}
function ro(e, t, r = !1) {
  let { routesMeta: n } = e,
    a = {},
    o = '/',
    i = [];
  for (let s = 0; s < n.length; ++s) {
    let l = n[s],
      u = s === n.length - 1,
      h = o === '/' ? t : t.slice(o.length) || '/',
      c = At(
        { path: l.relativePath, caseSensitive: l.caseSensitive, end: u },
        h
      ),
      y = l.route;
    if (
      (!c &&
        u &&
        r &&
        !n[n.length - 1].route.index &&
        (c = At(
          { path: l.relativePath, caseSensitive: l.caseSensitive, end: !1 },
          h
        )),
      !c)
    )
      return null;
    Object.assign(a, c.params),
      i.push({
        params: a,
        pathname: Le([o, c.pathname]),
        pathnameBase: lo(Le([o, c.pathnameBase])),
        route: y,
      }),
      c.pathnameBase !== '/' && (o = Le([o, c.pathnameBase]));
  }
  return i;
}
function At(e, t) {
  typeof e == 'string' && (e = { path: e, caseSensitive: !1, end: !0 });
  let [r, n] = Dn(e.path, e.caseSensitive, e.end),
    a = t.match(r);
  if (!a) return null;
  let o = a[0],
    i = o.replace(/(.)\/+$/, '$1'),
    s = a.slice(1);
  return {
    params: n.reduce((u, { paramName: h, isOptional: c }, y) => {
      if (h === '*') {
        let E = s[y] || '';
        i = o.slice(0, o.length - E.length).replace(/(.)\/+$/, '$1');
      }
      const g = s[y];
      return (
        c && !g ? (u[h] = void 0) : (u[h] = (g || '').replace(/%2F/g, '/')), u
      );
    }, {}),
    pathname: o,
    pathnameBase: i,
    pattern: e,
  };
}
function Dn(e, t = !1, r = !0) {
  ie(
    e === '*' || !e.endsWith('*') || e.endsWith('/*'),
    `Route path "${e}" will be treated as if it were "${e.replace(/\*$/, '/*')}" because the \`*\` character must always follow a \`/\` in the pattern. To get rid of this warning, please change the route path to "${e.replace(/\*$/, '/*')}".`
  );
  let n = [],
    a =
      '^' +
      e
        .replace(/\/*\*?$/, '')
        .replace(/^\/*/, '/')
        .replace(/[\\.*+^${}|()[\]]/g, '\\$&')
        .replace(
          /\/:([\w-]+)(\?)?/g,
          (i, s, l) => (
            n.push({ paramName: s, isOptional: l != null }),
            l ? '/?([^\\/]+)?' : '/([^\\/]+)'
          )
        )
        .replace(/\/([\w-]+)\?(\/|$)/g, '(/$1)?$2');
  return (
    e.endsWith('*')
      ? (n.push({ paramName: '*' }),
        (a += e === '*' || e === '/*' ? '(.*)$' : '(?:\\/(.+)|\\/*)$'))
      : r
        ? (a += '\\/*$')
        : e !== '' && e !== '/' && (a += '(?:(?=\\/|$))'),
    [new RegExp(a, t ? void 0 : 'i'), n]
  );
}
function no(e) {
  try {
    return e
      .split('/')
      .map((t) => decodeURIComponent(t).replace(/\//g, '%2F'))
      .join('/');
  } catch (t) {
    return (
      ie(
        !1,
        `The URL path "${e}" could not be decoded because it is a malformed URL segment. This is probably due to a bad percent encoding (${t}).`
      ),
      e
    );
  }
}
function Ee(e, t) {
  if (t === '/') return e;
  if (!e.toLowerCase().startsWith(t.toLowerCase())) return null;
  let r = t.endsWith('/') ? t.length - 1 : t.length,
    n = e.charAt(r);
  return n && n !== '/' ? null : e.slice(r) || '/';
}
function ao({ basename: e, pathname: t }) {
  return t === '/' ? e : Le([e, t]);
}
var oo = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i,
  $t = (e) => oo.test(e);
function io(e, t = '/') {
  let {
      pathname: r,
      search: n = '',
      hash: a = '',
    } = typeof e == 'string' ? $e(e) : e,
    o;
  if (r)
    if ($t(r)) o = r;
    else {
      if (r.includes('//')) {
        let i = r;
        (r = r.replace(/\/\/+/g, '/')),
          ie(
            !1,
            `Pathnames cannot have embedded double slashes - normalizing ${i} -> ${r}`
          );
      }
      r.startsWith('/') ? (o = Zr(r.substring(1), '/')) : (o = Zr(r, t));
    }
  else o = t;
  return { pathname: o, search: so(n), hash: uo(a) };
}
function Zr(e, t) {
  let r = t.replace(/\/+$/, '').split('/');
  return (
    e.split('/').forEach((a) => {
      a === '..' ? r.length > 1 && r.pop() : a !== '.' && r.push(a);
    }),
    r.length > 1 ? r.join('/') : '/'
  );
}
function Kt(e, t, r, n) {
  return `Cannot include a '${e}' character in a manually specified \`to.${t}\` field [${JSON.stringify(n)}].  Please separate it out to the \`to.${r}\` field. Alternatively you may provide the full path as a string in <Link to="..."> and the router will parse it for you.`;
}
function _n(e) {
  return e.filter(
    (t, r) => r === 0 || (t.route.path && t.route.path.length > 0)
  );
}
function mr(e) {
  let t = _n(e);
  return t.map((r, n) => (n === t.length - 1 ? r.pathname : r.pathnameBase));
}
function pr(e, t, r, n = !1) {
  let a;
  typeof e == 'string'
    ? (a = $e(e))
    : ((a = { ...e }),
      V(
        !a.pathname || !a.pathname.includes('?'),
        Kt('?', 'pathname', 'search', a)
      ),
      V(
        !a.pathname || !a.pathname.includes('#'),
        Kt('#', 'pathname', 'hash', a)
      ),
      V(!a.search || !a.search.includes('#'), Kt('#', 'search', 'hash', a)));
  let o = e === '' || a.pathname === '',
    i = o ? '/' : a.pathname,
    s;
  if (i == null) s = r;
  else {
    let c = t.length - 1;
    if (!n && i.startsWith('..')) {
      let y = i.split('/');
      for (; y[0] === '..'; ) y.shift(), (c -= 1);
      a.pathname = y.join('/');
    }
    s = c >= 0 ? t[c] : '/';
  }
  let l = io(a, s),
    u = i && i !== '/' && i.endsWith('/'),
    h = (o || i === '.') && r.endsWith('/');
  return !l.pathname.endsWith('/') && (u || h) && (l.pathname += '/'), l;
}
var Le = (e) => e.join('/').replace(/\/\/+/g, '/'),
  lo = (e) => e.replace(/\/+$/, '').replace(/^\/*/, '/'),
  so = (e) => (!e || e === '?' ? '' : e.startsWith('?') ? e : '?' + e),
  uo = (e) => (!e || e === '#' ? '' : e.startsWith('#') ? e : '#' + e),
  co = class {
    constructor(e, t) {
      (this.type = 'DataWithResponseInit'),
        (this.data = e),
        (this.init = t || null);
    }
  };
function fo(e, t) {
  return new co(e, typeof t == 'number' ? { status: t } : t);
}
var ho = (e, t = 302) => {
    let r = t;
    typeof r == 'number'
      ? (r = { status: r })
      : typeof r.status > 'u' && (r.status = 302);
    let n = new Headers(r.headers);
    return n.set('Location', e), new Response(null, { ...r, headers: n });
  },
  Ye = class {
    constructor(e, t, r, n = !1) {
      (this.status = e),
        (this.statusText = t || ''),
        (this.internal = n),
        r instanceof Error
          ? ((this.data = r.toString()), (this.error = r))
          : (this.data = r);
    }
  };
function We(e) {
  return (
    e != null &&
    typeof e.status == 'number' &&
    typeof e.statusText == 'string' &&
    typeof e.internal == 'boolean' &&
    'data' in e
  );
}
function ft(e) {
  return (
    e
      .map((t) => t.route.path)
      .filter(Boolean)
      .join('/')
      .replace(/\/\/*/g, '/') || '/'
  );
}
var Ie = Symbol('Uninstrumented');
function mo(e, t) {
  let r = {
    lazy: [],
    'lazy.loader': [],
    'lazy.action': [],
    'lazy.middleware': [],
    middleware: [],
    loader: [],
    action: [],
  };
  e.forEach((a) =>
    a({
      id: t.id,
      index: t.index,
      path: t.path,
      instrument(o) {
        let i = Object.keys(r);
        for (let s of i) o[s] && r[s].push(o[s]);
      },
    })
  );
  let n = {};
  if (typeof t.lazy == 'function' && r.lazy.length > 0) {
    let a = Ke(r.lazy, t.lazy, () => {});
    a && (n.lazy = a);
  }
  if (typeof t.lazy == 'object') {
    let a = t.lazy;
    ['middleware', 'loader', 'action'].forEach((o) => {
      let i = a[o],
        s = r[`lazy.${o}`];
      if (typeof i == 'function' && s.length > 0) {
        let l = Ke(s, i, () => {});
        l && (n.lazy = Object.assign(n.lazy || {}, { [o]: l }));
      }
    });
  }
  return (
    ['loader', 'action'].forEach((a) => {
      let o = t[a];
      if (typeof o == 'function' && r[a].length > 0) {
        let i = o[Ie] ?? o,
          s = Ke(r[a], i, (...l) => en(l[0]));
        s && ((s[Ie] = i), (n[a] = s));
      }
    }),
    t.middleware &&
      t.middleware.length > 0 &&
      r.middleware.length > 0 &&
      (n.middleware = t.middleware.map((a) => {
        let o = a[Ie] ?? a,
          i = Ke(r.middleware, o, (...s) => en(s[0]));
        return i ? ((i[Ie] = o), i) : a;
      })),
    n
  );
}
function po(e, t) {
  let r = { navigate: [], fetch: [] };
  if (
    (t.forEach((n) =>
      n({
        instrument(a) {
          let o = Object.keys(a);
          for (let i of o) a[i] && r[i].push(a[i]);
        },
      })
    ),
    r.navigate.length > 0)
  ) {
    let n = e.navigate[Ie] ?? e.navigate,
      a = Ke(r.navigate, n, (...o) => {
        let [i, s] = o;
        return {
          to:
            typeof i == 'number' || typeof i == 'string' ? i : i ? Pe(i) : '.',
          ...tn(e, s ?? {}),
        };
      });
    a && ((a[Ie] = n), (e.navigate = a));
  }
  if (r.fetch.length > 0) {
    let n = e.fetch[Ie] ?? e.fetch,
      a = Ke(r.fetch, n, (...o) => {
        let [i, , s, l] = o;
        return { href: s ?? '.', fetcherKey: i, ...tn(e, l ?? {}) };
      });
    a && ((a[Ie] = n), (e.fetch = a));
  }
  return e;
}
function Ke(e, t, r) {
  return e.length === 0
    ? null
    : async (...n) => {
        let a = await On(e, r(...n), () => t(...n), e.length - 1);
        if (a.type === 'error') throw a.value;
        return a.value;
      };
}
async function On(e, t, r, n) {
  let a = e[n],
    o;
  if (a) {
    let i,
      s = async () => (
        i
          ? console.error(
              'You cannot call instrumented handlers more than once'
            )
          : (i = On(e, t, r, n - 1)),
        (o = await i),
        V(o, 'Expected a result'),
        o.type === 'error' && o.value instanceof Error
          ? { status: 'error', error: o.value }
          : { status: 'success', error: void 0 }
      );
    try {
      await a(s, t);
    } catch (l) {
      console.error('An instrumentation function threw an error:', l);
    }
    i || (await s()), await i;
  } else
    try {
      o = { type: 'success', value: await r() };
    } catch (i) {
      o = { type: 'error', value: i };
    }
  return (
    o || {
      type: 'error',
      value: new Error('No result assigned in instrumentation chain.'),
    }
  );
}
function en(e) {
  let { request: t, context: r, params: n, unstable_pattern: a } = e;
  return {
    request: yo(t),
    params: { ...n },
    unstable_pattern: a,
    context: vo(r),
  };
}
function tn(e, t) {
  return {
    currentUrl: Pe(e.state.location),
    ...('formMethod' in t ? { formMethod: t.formMethod } : {}),
    ...('formEncType' in t ? { formEncType: t.formEncType } : {}),
    ...('formData' in t ? { formData: t.formData } : {}),
    ...('body' in t ? { body: t.body } : {}),
  };
}
function yo(e) {
  return {
    method: e.method,
    url: e.url,
    headers: { get: (...t) => e.headers.get(...t) },
  };
}
function vo(e) {
  if (wo(e)) {
    let t = { ...e };
    return Object.freeze(t), t;
  } else return { get: (t) => e.get(t) };
}
var go = Object.getOwnPropertyNames(Object.prototype).sort().join('\0');
function wo(e) {
  if (e === null || typeof e != 'object') return !1;
  const t = Object.getPrototypeOf(e);
  return (
    t === Object.prototype ||
    t === null ||
    Object.getOwnPropertyNames(t).sort().join('\0') === go
  );
}
var An = ['POST', 'PUT', 'PATCH', 'DELETE'],
  Eo = new Set(An),
  Ro = ['GET', ...An],
  bo = new Set(Ro),
  So = new Set([301, 302, 303, 307, 308]),
  xo = new Set([307, 308]),
  qt = {
    state: 'idle',
    location: void 0,
    formMethod: void 0,
    formAction: void 0,
    formEncType: void 0,
    formData: void 0,
    json: void 0,
    text: void 0,
  },
  Co = {
    state: 'idle',
    data: void 0,
    formMethod: void 0,
    formAction: void 0,
    formEncType: void 0,
    formData: void 0,
    json: void 0,
    text: void 0,
  },
  at = { state: 'unblocked', proceed: void 0, reset: void 0, location: void 0 },
  Lo = (e) => ({ hasErrorBoundary: !!e.hasErrorBoundary }),
  Nn = 'remix-router-transitions',
  kn = Symbol('ResetLoaderData');
function Ql(e) {
  const t = e.window ? e.window : typeof window < 'u' ? window : void 0,
    r =
      typeof t < 'u' &&
      typeof t.document < 'u' &&
      typeof t.document.createElement < 'u';
  V(
    e.routes.length > 0,
    'You must provide a non-empty routes array to createRouter'
  );
  let n = e.hydrationRouteProperties || [],
    a = e.mapRouteProperties || Lo,
    o = a;
  if (e.unstable_instrumentations) {
    let d = e.unstable_instrumentations;
    o = (v) => ({ ...a(v), ...mo(d.map((w) => w.route).filter(Boolean), v) });
  }
  let i = {},
    s = ct(e.routes, o, void 0, i),
    l,
    u = e.basename || '/';
  u.startsWith('/') || (u = `/${u}`);
  let h = e.dataStrategy || _o,
    c = { ...e.future },
    y = null,
    g = new Set(),
    E = null,
    L = null,
    R = null,
    x = e.hydrationData != null,
    b = Ae(s, e.history.location, u),
    T = !1,
    M = null,
    D;
  if (b == null && !e.patchRoutesOnNavigation) {
    let d = Se(404, { pathname: e.history.location.pathname }),
      { matches: v, route: w } = St(s);
    (D = !0), (b = v), (M = { [w.id]: d });
  } else if (
    (b &&
      !e.hydrationData &&
      gt(b, s, e.history.location.pathname).active &&
      (b = null),
    b)
  )
    if (b.some((d) => d.route.lazy)) D = !1;
    else if (!b.some((d) => yr(d.route))) D = !0;
    else {
      let d = e.hydrationData ? e.hydrationData.loaderData : null,
        v = e.hydrationData ? e.hydrationData.errors : null;
      if (v) {
        let w = b.findIndex((C) => v[C.route.id] !== void 0);
        D = b.slice(0, w + 1).every((C) => !ar(C.route, d, v));
      } else D = b.every((w) => !ar(w.route, d, v));
    }
  else {
    (D = !1), (b = []);
    let d = gt(null, s, e.history.location.pathname);
    d.active && d.matches && ((T = !0), (b = d.matches));
  }
  let k,
    m = {
      historyAction: e.history.action,
      location: e.history.location,
      matches: b,
      initialized: D,
      navigation: qt,
      restoreScrollPosition: e.hydrationData != null ? !1 : null,
      preventScrollReset: !1,
      revalidation: 'idle',
      loaderData: (e.hydrationData && e.hydrationData.loaderData) || {},
      actionData: (e.hydrationData && e.hydrationData.actionData) || null,
      errors: (e.hydrationData && e.hydrationData.errors) || M,
      fetchers: new Map(),
      blockers: new Map(),
    },
    B = 'POP',
    W = null,
    G = !1,
    U,
    se = !1,
    Z = new Map(),
    q = null,
    ne = !1,
    te = !1,
    ue = new Set(),
    ee = new Map(),
    fe = 0,
    be = -1,
    p = new Map(),
    S = new Set(),
    I = new Map(),
    H = new Map(),
    Y = new Set(),
    J = new Map(),
    Q,
    he = null;
  function me() {
    if (
      ((y = e.history.listen(({ action: d, location: v, delta: w }) => {
        if (Q) {
          Q(), (Q = void 0);
          return;
        }
        ie(
          J.size === 0 || w != null,
          'You are trying to use a blocker on a POP navigation to a location that was not created by @remix-run/router. This will fail silently in production. This can happen if you are navigating outside the router via `window.history.pushState`/`window.location.hash` instead of using router navigation APIs.  This can also happen if you are using createHashRouter and the user manually changes the URL.'
        );
        let C = jr({
          currentLocation: m.location,
          nextLocation: v,
          historyAction: d,
        });
        if (C && w != null) {
          let P = new Promise((O) => {
            Q = O;
          });
          e.history.go(w * -1),
            vt(C, {
              state: 'blocked',
              location: v,
              proceed() {
                vt(C, {
                  state: 'proceeding',
                  proceed: void 0,
                  reset: void 0,
                  location: v,
                }),
                  P.then(() => e.history.go(w));
              },
              reset() {
                let O = new Map(m.blockers);
                O.set(C, at), pe({ blockers: O });
              },
            }),
            W?.resolve(),
            (W = null);
          return;
        }
        return Fe(d, v);
      })),
      r)
    ) {
      Jo(t, Z);
      let d = () => Go(t, Z);
      t.addEventListener('pagehide', d),
        (q = () => t.removeEventListener('pagehide', d));
    }
    return m.initialized || Fe('POP', m.location, { initialHydration: !0 }), k;
  }
  function zt() {
    y && y(),
      q && q(),
      g.clear(),
      U && U.abort(),
      m.fetchers.forEach((d, v) => Wt(v)),
      m.blockers.forEach((d, v) => Fr(v));
  }
  function ma(d) {
    return g.add(d), () => g.delete(d);
  }
  function pe(d, v = {}) {
    d.matches &&
      (d.matches = d.matches.map((P) => {
        let O = i[P.route.id],
          A = P.route;
        return A.element !== O.element ||
          A.errorElement !== O.errorElement ||
          A.hydrateFallbackElement !== O.hydrateFallbackElement
          ? { ...P, route: O }
          : P;
      })),
      (m = { ...m, ...d });
    let w = [],
      C = [];
    m.fetchers.forEach((P, O) => {
      P.state === 'idle' && (Y.has(O) ? w.push(O) : C.push(O));
    }),
      Y.forEach((P) => {
        !m.fetchers.has(P) && !ee.has(P) && w.push(P);
      }),
      [...g].forEach((P) =>
        P(m, {
          deletedFetchers: w,
          newErrors: d.errors ?? null,
          viewTransitionOpts: v.viewTransitionOpts,
          flushSync: v.flushSync === !0,
        })
      ),
      w.forEach((P) => Wt(P)),
      C.forEach((P) => m.fetchers.delete(P));
  }
  function Je(d, v, { flushSync: w } = {}) {
    let C =
        m.actionData != null &&
        m.navigation.formMethod != null &&
        ve(m.navigation.formMethod) &&
        m.navigation.state === 'loading' &&
        d.state?._isRedirect !== !0,
      P;
    v.actionData
      ? Object.keys(v.actionData).length > 0
        ? (P = v.actionData)
        : (P = null)
      : C
        ? (P = m.actionData)
        : (P = null);
    let O = v.loaderData
        ? fn(m.loaderData, v.loaderData, v.matches || [], v.errors)
        : m.loaderData,
      A = m.blockers;
    A.size > 0 && ((A = new Map(A)), A.forEach(($, F) => A.set(F, at)));
    let _ = ne ? !1 : Ur(d, v.matches || m.matches),
      N =
        G === !0 ||
        (m.navigation.formMethod != null &&
          ve(m.navigation.formMethod) &&
          d.state?._isRedirect !== !0);
    l && ((s = l), (l = void 0)),
      ne ||
        B === 'POP' ||
        (B === 'PUSH'
          ? e.history.push(d, d.state)
          : B === 'REPLACE' && e.history.replace(d, d.state));
    let j;
    if (B === 'POP') {
      let $ = Z.get(m.location.pathname);
      $ && $.has(d.pathname)
        ? (j = { currentLocation: m.location, nextLocation: d })
        : Z.has(d.pathname) &&
          (j = { currentLocation: d, nextLocation: m.location });
    } else if (se) {
      let $ = Z.get(m.location.pathname);
      $
        ? $.add(d.pathname)
        : (($ = new Set([d.pathname])), Z.set(m.location.pathname, $)),
        (j = { currentLocation: m.location, nextLocation: d });
    }
    pe(
      {
        ...v,
        actionData: P,
        loaderData: O,
        historyAction: B,
        location: d,
        initialized: !0,
        navigation: qt,
        revalidation: 'idle',
        restoreScrollPosition: _,
        preventScrollReset: N,
        blockers: A,
      },
      { viewTransitionOpts: j, flushSync: w === !0 }
    ),
      (B = 'POP'),
      (G = !1),
      (se = !1),
      (ne = !1),
      (te = !1),
      W?.resolve(),
      (W = null),
      he?.resolve(),
      (he = null);
  }
  async function _r(d, v) {
    if ((W?.resolve(), (W = null), typeof d == 'number')) {
      W || (W = pn());
      let re = W.promise;
      return e.history.go(d), re;
    }
    let w = nr(m.location, m.matches, u, d, v?.fromRouteId, v?.relative),
      { path: C, submission: P, error: O } = rn(!1, w, v),
      A = m.location,
      _ = ut(m.location, C, v && v.state);
    _ = { ..._, ...e.history.encodeLocation(_) };
    let N = v && v.replace != null ? v.replace : void 0,
      j = 'PUSH';
    N === !0
      ? (j = 'REPLACE')
      : N === !1 ||
        (P != null &&
          ve(P.formMethod) &&
          P.formAction === m.location.pathname + m.location.search &&
          (j = 'REPLACE'));
    let $ =
        v && 'preventScrollReset' in v ? v.preventScrollReset === !0 : void 0,
      F = (v && v.flushSync) === !0,
      X = jr({ currentLocation: A, nextLocation: _, historyAction: j });
    if (X) {
      vt(X, {
        state: 'blocked',
        location: _,
        proceed() {
          vt(X, {
            state: 'proceeding',
            proceed: void 0,
            reset: void 0,
            location: _,
          }),
            _r(d, v);
        },
        reset() {
          let re = new Map(m.blockers);
          re.set(X, at), pe({ blockers: re });
        },
      });
      return;
    }
    await Fe(j, _, {
      submission: P,
      pendingError: O,
      preventScrollReset: $,
      replace: v && v.replace,
      enableViewTransition: v && v.viewTransition,
      flushSync: F,
    });
  }
  function pa() {
    he || (he = pn()), Bt(), pe({ revalidation: 'loading' });
    let d = he.promise;
    return m.navigation.state === 'submitting'
      ? d
      : m.navigation.state === 'idle'
        ? (Fe(m.historyAction, m.location, {
            startUninterruptedRevalidation: !0,
          }),
          d)
        : (Fe(B || m.historyAction, m.navigation.location, {
            overrideNavigation: m.navigation,
            enableViewTransition: se === !0,
          }),
          d);
  }
  async function Fe(d, v, w) {
    U && U.abort(),
      (U = null),
      (B = d),
      (ne = (w && w.startUninterruptedRevalidation) === !0),
      La(m.location, m.matches),
      (G = (w && w.preventScrollReset) === !0),
      (se = (w && w.enableViewTransition) === !0);
    let C = l || s,
      P = w && w.overrideNavigation,
      O =
        w?.initialHydration && m.matches && m.matches.length > 0 && !T
          ? m.matches
          : Ae(C, v, u),
      A = (w && w.flushSync) === !0;
    if (
      O &&
      m.initialized &&
      !te &&
      jo(m.location, v) &&
      !(w && w.submission && ve(w.submission.formMethod))
    ) {
      Je(v, { matches: O }, { flushSync: A });
      return;
    }
    let _ = gt(O, C, v.pathname);
    if ((_.active && _.matches && (O = _.matches), !O)) {
      let { error: de, notFoundMatches: ae, route: oe } = Yt(v.pathname);
      Je(
        v,
        { matches: ae, loaderData: {}, errors: { [oe.id]: de } },
        { flushSync: A }
      );
      return;
    }
    U = new AbortController();
    let N = Xe(e.history, v, U.signal, w && w.submission),
      j = e.getContext ? await e.getContext() : new Kr(),
      $;
    if (w && w.pendingError)
      $ = [ke(O).route.id, { type: 'error', error: w.pendingError }];
    else if (w && w.submission && ve(w.submission.formMethod)) {
      let de = await ya(
        N,
        v,
        w.submission,
        O,
        j,
        _.active,
        w && w.initialHydration === !0,
        { replace: w.replace, flushSync: A }
      );
      if (de.shortCircuited) return;
      if (de.pendingActionResult) {
        let [ae, oe] = de.pendingActionResult;
        if (we(oe) && We(oe.error) && oe.error.status === 404) {
          (U = null),
            Je(v, {
              matches: de.matches,
              loaderData: {},
              errors: { [ae]: oe.error },
            });
          return;
        }
      }
      (O = de.matches || O),
        ($ = de.pendingActionResult),
        (P = Qt(v, w.submission)),
        (A = !1),
        (_.active = !1),
        (N = Xe(e.history, N.url, N.signal));
    }
    let {
      shortCircuited: F,
      matches: X,
      loaderData: re,
      errors: ce,
    } = await va(
      N,
      v,
      O,
      j,
      _.active,
      P,
      w && w.submission,
      w && w.fetcherSubmission,
      w && w.replace,
      w && w.initialHydration === !0,
      A,
      $
    );
    F ||
      ((U = null),
      Je(v, { matches: X || O, ...hn($), loaderData: re, errors: ce }));
  }
  async function ya(d, v, w, C, P, O, A, _ = {}) {
    Bt();
    let N = Yo(v, w);
    if ((pe({ navigation: N }, { flushSync: _.flushSync === !0 }), O)) {
      let F = await wt(C, v.pathname, d.signal);
      if (F.type === 'aborted') return { shortCircuited: !0 };
      if (F.type === 'error') {
        if (F.partialMatches.length === 0) {
          let { matches: re, route: ce } = St(s);
          return {
            matches: re,
            pendingActionResult: [ce.id, { type: 'error', error: F.error }],
          };
        }
        let X = ke(F.partialMatches).route.id;
        return {
          matches: F.partialMatches,
          pendingActionResult: [X, { type: 'error', error: F.error }],
        };
      } else if (F.matches) C = F.matches;
      else {
        let { notFoundMatches: X, error: re, route: ce } = Yt(v.pathname);
        return {
          matches: X,
          pendingActionResult: [ce.id, { type: 'error', error: re }],
        };
      }
    }
    let j,
      $ = Tt(C, v);
    if (!$.route.action && !$.route.lazy)
      j = {
        type: 'error',
        error: Se(405, {
          method: d.method,
          pathname: v.pathname,
          routeId: $.route.id,
        }),
      };
    else {
      let F = qe(o, i, d, C, $, A ? [] : n, P),
        X = await et(d, F, P, null);
      if (((j = X[$.route.id]), !j)) {
        for (let re of C)
          if (X[re.route.id]) {
            j = X[re.route.id];
            break;
          }
      }
      if (d.signal.aborted) return { shortCircuited: !0 };
    }
    if (Be(j)) {
      let F;
      return (
        _ && _.replace != null
          ? (F = _.replace)
          : (F =
              un(j.response.headers.get('Location'), new URL(d.url), u) ===
              m.location.pathname + m.location.search),
        await je(d, j, !0, { submission: w, replace: F }),
        { shortCircuited: !0 }
      );
    }
    if (we(j)) {
      let F = ke(C, $.route.id);
      return (
        (_ && _.replace) !== !0 && (B = 'PUSH'),
        { matches: C, pendingActionResult: [F.route.id, j, $.route.id] }
      );
    }
    return { matches: C, pendingActionResult: [$.route.id, j] };
  }
  async function va(d, v, w, C, P, O, A, _, N, j, $, F) {
    let X = O || Qt(v, A),
      re = A || _ || mn(X),
      ce = !ne && !j;
    if (P) {
      if (ce) {
        let ye = Or(F);
        pe(
          { navigation: X, ...(ye !== void 0 ? { actionData: ye } : {}) },
          { flushSync: $ }
        );
      }
      let K = await wt(w, v.pathname, d.signal);
      if (K.type === 'aborted') return { shortCircuited: !0 };
      if (K.type === 'error') {
        if (K.partialMatches.length === 0) {
          let { matches: Ge, route: ze } = St(s);
          return { matches: Ge, loaderData: {}, errors: { [ze.id]: K.error } };
        }
        let ye = ke(K.partialMatches).route.id;
        return {
          matches: K.partialMatches,
          loaderData: {},
          errors: { [ye]: K.error },
        };
      } else if (K.matches) w = K.matches;
      else {
        let { error: ye, notFoundMatches: Ge, route: ze } = Yt(v.pathname);
        return { matches: Ge, loaderData: {}, errors: { [ze.id]: ye } };
      }
    }
    let de = l || s,
      { dsMatches: ae, revalidatingFetchers: oe } = nn(
        d,
        C,
        o,
        i,
        e.history,
        m,
        w,
        re,
        v,
        j ? [] : n,
        j === !0,
        te,
        ue,
        Y,
        I,
        S,
        de,
        u,
        e.patchRoutesOnNavigation != null,
        F
      );
    if (
      ((be = ++fe),
      !e.dataStrategy &&
        !ae.some((K) => K.shouldLoad) &&
        !ae.some((K) => K.route.middleware && K.route.middleware.length > 0) &&
        oe.length === 0)
    ) {
      let K = Ir();
      return (
        Je(
          v,
          {
            matches: w,
            loaderData: {},
            errors: F && we(F[1]) ? { [F[0]]: F[1].error } : null,
            ...hn(F),
            ...(K ? { fetchers: new Map(m.fetchers) } : {}),
          },
          { flushSync: $ }
        ),
        { shortCircuited: !0 }
      );
    }
    if (ce) {
      let K = {};
      if (!P) {
        K.navigation = X;
        let ye = Or(F);
        ye !== void 0 && (K.actionData = ye);
      }
      oe.length > 0 && (K.fetchers = ga(oe)), pe(K, { flushSync: $ });
    }
    oe.forEach((K) => {
      _e(K.key), K.controller && ee.set(K.key, K.controller);
    });
    let He = () => oe.forEach((K) => _e(K.key));
    U && U.signal.addEventListener('abort', He);
    let { loaderResults: tt, fetcherResults: Ne } = await Ar(ae, oe, d, C);
    if (d.signal.aborted) return { shortCircuited: !0 };
    U && U.signal.removeEventListener('abort', He),
      oe.forEach((K) => ee.delete(K.key));
    let Ce = xt(tt);
    if (Ce)
      return await je(d, Ce.result, !0, { replace: N }), { shortCircuited: !0 };
    if (((Ce = xt(Ne)), Ce))
      return (
        S.add(Ce.key),
        await je(d, Ce.result, !0, { replace: N }),
        { shortCircuited: !0 }
      );
    let { loaderData: Vt, errors: rt } = dn(m, w, tt, F, oe, Ne);
    j && m.errors && (rt = { ...m.errors, ...rt });
    let Ue = Ir(),
      Et = $r(be),
      Rt = Ue || Et || oe.length > 0;
    return {
      matches: w,
      loaderData: Vt,
      errors: rt,
      ...(Rt ? { fetchers: new Map(m.fetchers) } : {}),
    };
  }
  function Or(d) {
    if (d && !we(d[1])) return { [d[0]]: d[1].data };
    if (m.actionData)
      return Object.keys(m.actionData).length === 0 ? null : m.actionData;
  }
  function ga(d) {
    return (
      d.forEach((v) => {
        let w = m.fetchers.get(v.key),
          C = ot(void 0, w ? w.data : void 0);
        m.fetchers.set(v.key, C);
      }),
      new Map(m.fetchers)
    );
  }
  async function wa(d, v, w, C) {
    _e(d);
    let P = (C && C.flushSync) === !0,
      O = l || s,
      A = nr(m.location, m.matches, u, w, v, C?.relative),
      _ = Ae(O, A, u),
      N = gt(_, O, A);
    if ((N.active && N.matches && (_ = N.matches), !_)) {
      De(d, v, Se(404, { pathname: A }), { flushSync: P });
      return;
    }
    let { path: j, submission: $, error: F } = rn(!0, A, C);
    if (F) {
      De(d, v, F, { flushSync: P });
      return;
    }
    let X = e.getContext ? await e.getContext() : new Kr(),
      re = (C && C.preventScrollReset) === !0;
    if ($ && ve($.formMethod)) {
      await Ea(d, v, j, _, X, N.active, P, re, $);
      return;
    }
    I.set(d, { routeId: v, path: j }),
      await Ra(d, v, j, _, X, N.active, P, re, $);
  }
  async function Ea(d, v, w, C, P, O, A, _, N) {
    Bt(), I.delete(d);
    let j = m.fetchers.get(d);
    Te(d, Vo(N, j), { flushSync: A });
    let $ = new AbortController(),
      F = Xe(e.history, w, $.signal, N);
    if (O) {
      let le = await wt(C, new URL(F.url).pathname, F.signal, d);
      if (le.type === 'aborted') return;
      if (le.type === 'error') {
        De(d, v, le.error, { flushSync: A });
        return;
      } else if (le.matches) C = le.matches;
      else {
        De(d, v, Se(404, { pathname: w }), { flushSync: A });
        return;
      }
    }
    let X = Tt(C, w);
    if (!X.route.action && !X.route.lazy) {
      let le = Se(405, { method: N.formMethod, pathname: w, routeId: v });
      De(d, v, le, { flushSync: A });
      return;
    }
    ee.set(d, $);
    let re = fe,
      ce = qe(o, i, F, C, X, n, P),
      de = await et(F, ce, P, d),
      ae = de[X.route.id];
    if (!ae) {
      for (let le of ce)
        if (de[le.route.id]) {
          ae = de[le.route.id];
          break;
        }
    }
    if (F.signal.aborted) {
      ee.get(d) === $ && ee.delete(d);
      return;
    }
    if (Y.has(d)) {
      if (Be(ae) || we(ae)) {
        Te(d, Oe(void 0));
        return;
      }
    } else {
      if (Be(ae))
        if ((ee.delete(d), be > re)) {
          Te(d, Oe(void 0));
          return;
        } else
          return (
            S.add(d),
            Te(d, ot(N)),
            je(F, ae, !1, { fetcherSubmission: N, preventScrollReset: _ })
          );
      if (we(ae)) {
        De(d, v, ae.error);
        return;
      }
    }
    let oe = m.navigation.location || m.location,
      He = Xe(e.history, oe, $.signal),
      tt = l || s,
      Ne =
        m.navigation.state !== 'idle'
          ? Ae(tt, m.navigation.location, u)
          : m.matches;
    V(Ne, "Didn't find any matches after fetcher action");
    let Ce = ++fe;
    p.set(d, Ce);
    let Vt = ot(N, ae.data);
    m.fetchers.set(d, Vt);
    let { dsMatches: rt, revalidatingFetchers: Ue } = nn(
      He,
      P,
      o,
      i,
      e.history,
      m,
      Ne,
      N,
      oe,
      n,
      !1,
      te,
      ue,
      Y,
      I,
      S,
      tt,
      u,
      e.patchRoutesOnNavigation != null,
      [X.route.id, ae]
    );
    Ue.filter((le) => le.key !== d).forEach((le) => {
      let bt = le.key,
        Br = m.fetchers.get(bt),
        Ta = ot(void 0, Br ? Br.data : void 0);
      m.fetchers.set(bt, Ta),
        _e(bt),
        le.controller && ee.set(bt, le.controller);
    }),
      pe({ fetchers: new Map(m.fetchers) });
    let Et = () => Ue.forEach((le) => _e(le.key));
    $.signal.addEventListener('abort', Et);
    let { loaderResults: Rt, fetcherResults: K } = await Ar(rt, Ue, He, P);
    if ($.signal.aborted) return;
    if (
      ($.signal.removeEventListener('abort', Et),
      p.delete(d),
      ee.delete(d),
      Ue.forEach((le) => ee.delete(le.key)),
      m.fetchers.has(d))
    ) {
      let le = Oe(ae.data);
      m.fetchers.set(d, le);
    }
    let ye = xt(Rt);
    if (ye) return je(He, ye.result, !1, { preventScrollReset: _ });
    if (((ye = xt(K)), ye))
      return S.add(ye.key), je(He, ye.result, !1, { preventScrollReset: _ });
    let { loaderData: Ge, errors: ze } = dn(m, Ne, Rt, void 0, Ue, K);
    $r(Ce),
      m.navigation.state === 'loading' && Ce > be
        ? (V(B, 'Expected pending action'),
          U && U.abort(),
          Je(m.navigation.location, {
            matches: Ne,
            loaderData: Ge,
            errors: ze,
            fetchers: new Map(m.fetchers),
          }))
        : (pe({
            errors: ze,
            loaderData: fn(m.loaderData, Ge, Ne, ze),
            fetchers: new Map(m.fetchers),
          }),
          (te = !1));
  }
  async function Ra(d, v, w, C, P, O, A, _, N) {
    let j = m.fetchers.get(d);
    Te(d, ot(N, j ? j.data : void 0), { flushSync: A });
    let $ = new AbortController(),
      F = Xe(e.history, w, $.signal);
    if (O) {
      let oe = await wt(C, new URL(F.url).pathname, F.signal, d);
      if (oe.type === 'aborted') return;
      if (oe.type === 'error') {
        De(d, v, oe.error, { flushSync: A });
        return;
      } else if (oe.matches) C = oe.matches;
      else {
        De(d, v, Se(404, { pathname: w }), { flushSync: A });
        return;
      }
    }
    let X = Tt(C, w);
    ee.set(d, $);
    let re = fe,
      ce = qe(o, i, F, C, X, n, P),
      ae = (await et(F, ce, P, d))[X.route.id];
    if ((ee.get(d) === $ && ee.delete(d), !F.signal.aborted)) {
      if (Y.has(d)) {
        Te(d, Oe(void 0));
        return;
      }
      if (Be(ae))
        if (be > re) {
          Te(d, Oe(void 0));
          return;
        } else {
          S.add(d), await je(F, ae, !1, { preventScrollReset: _ });
          return;
        }
      if (we(ae)) {
        De(d, v, ae.error);
        return;
      }
      Te(d, Oe(ae.data));
    }
  }
  async function je(
    d,
    v,
    w,
    {
      submission: C,
      fetcherSubmission: P,
      preventScrollReset: O,
      replace: A,
    } = {}
  ) {
    w || (W?.resolve(), (W = null)),
      v.response.headers.has('X-Remix-Revalidate') && (te = !0);
    let _ = v.response.headers.get('Location');
    V(_, 'Expected a Location header on the redirect Response'),
      (_ = un(_, new URL(d.url), u));
    let N = ut(m.location, _, { _isRedirect: !0 });
    if (r) {
      let ce = !1;
      if (v.response.headers.has('X-Remix-Reload-Document')) ce = !0;
      else if ($t(_)) {
        const de = Ln(_, !0);
        ce = de.origin !== t.location.origin || Ee(de.pathname, u) == null;
      }
      if (ce) {
        A ? t.location.replace(_) : t.location.assign(_);
        return;
      }
    }
    U = null;
    let j =
        A === !0 || v.response.headers.has('X-Remix-Replace')
          ? 'REPLACE'
          : 'PUSH',
      { formMethod: $, formAction: F, formEncType: X } = m.navigation;
    !C && !P && $ && F && X && (C = mn(m.navigation));
    let re = C || P;
    if (xo.has(v.response.status) && re && ve(re.formMethod))
      await Fe(j, N, {
        submission: { ...re, formAction: _ },
        preventScrollReset: O || G,
        enableViewTransition: w ? se : void 0,
      });
    else {
      let ce = Qt(N, C);
      await Fe(j, N, {
        overrideNavigation: ce,
        fetcherSubmission: P,
        preventScrollReset: O || G,
        enableViewTransition: w ? se : void 0,
      });
    }
  }
  async function et(d, v, w, C) {
    let P,
      O = {};
    try {
      P = await Ao(h, d, v, C, w, !1);
    } catch (A) {
      return (
        v
          .filter((_) => _.shouldLoad)
          .forEach((_) => {
            O[_.route.id] = { type: 'error', error: A };
          }),
        O
      );
    }
    if (d.signal.aborted) return O;
    for (let [A, _] of Object.entries(P))
      if (Bo(_)) {
        let N = _.result;
        O[A] = { type: 'redirect', response: $o(N, d, A, v, u) };
      } else O[A] = await Io(_);
    return O;
  }
  async function Ar(d, v, w, C) {
    let P = et(w, d, C, null),
      O = Promise.all(
        v.map(async (N) => {
          if (N.matches && N.match && N.request && N.controller) {
            let $ = (await et(N.request, N.matches, C, N.key))[
              N.match.route.id
            ];
            return { [N.key]: $ };
          } else
            return Promise.resolve({
              [N.key]: { type: 'error', error: Se(404, { pathname: N.path }) },
            });
        })
      ),
      A = await P,
      _ = (await O).reduce((N, j) => Object.assign(N, j), {});
    return { loaderResults: A, fetcherResults: _ };
  }
  function Bt() {
    (te = !0),
      I.forEach((d, v) => {
        ee.has(v) && ue.add(v), _e(v);
      });
  }
  function Te(d, v, w = {}) {
    m.fetchers.set(d, v),
      pe(
        { fetchers: new Map(m.fetchers) },
        { flushSync: (w && w.flushSync) === !0 }
      );
  }
  function De(d, v, w, C = {}) {
    let P = ke(m.matches, v);
    Wt(d),
      pe(
        { errors: { [P.route.id]: w }, fetchers: new Map(m.fetchers) },
        { flushSync: (C && C.flushSync) === !0 }
      );
  }
  function Nr(d) {
    return (
      H.set(d, (H.get(d) || 0) + 1),
      Y.has(d) && Y.delete(d),
      m.fetchers.get(d) || Co
    );
  }
  function ba(d, v) {
    _e(d, v?.reason), Te(d, Oe(null));
  }
  function Wt(d) {
    let v = m.fetchers.get(d);
    ee.has(d) && !(v && v.state === 'loading' && p.has(d)) && _e(d),
      I.delete(d),
      p.delete(d),
      S.delete(d),
      Y.delete(d),
      ue.delete(d),
      m.fetchers.delete(d);
  }
  function Sa(d) {
    let v = (H.get(d) || 0) - 1;
    v <= 0 ? (H.delete(d), Y.add(d)) : H.set(d, v),
      pe({ fetchers: new Map(m.fetchers) });
  }
  function _e(d, v) {
    let w = ee.get(d);
    w && (w.abort(v), ee.delete(d));
  }
  function kr(d) {
    for (let v of d) {
      let w = Nr(v),
        C = Oe(w.data);
      m.fetchers.set(v, C);
    }
  }
  function Ir() {
    let d = [],
      v = !1;
    for (let w of S) {
      let C = m.fetchers.get(w);
      V(C, `Expected fetcher: ${w}`),
        C.state === 'loading' && (S.delete(w), d.push(w), (v = !0));
    }
    return kr(d), v;
  }
  function $r(d) {
    let v = [];
    for (let [w, C] of p)
      if (C < d) {
        let P = m.fetchers.get(w);
        V(P, `Expected fetcher: ${w}`),
          P.state === 'loading' && (_e(w), p.delete(w), v.push(w));
      }
    return kr(v), v.length > 0;
  }
  function xa(d, v) {
    let w = m.blockers.get(d) || at;
    return J.get(d) !== v && J.set(d, v), w;
  }
  function Fr(d) {
    m.blockers.delete(d), J.delete(d);
  }
  function vt(d, v) {
    let w = m.blockers.get(d) || at;
    V(
      (w.state === 'unblocked' && v.state === 'blocked') ||
        (w.state === 'blocked' && v.state === 'blocked') ||
        (w.state === 'blocked' && v.state === 'proceeding') ||
        (w.state === 'blocked' && v.state === 'unblocked') ||
        (w.state === 'proceeding' && v.state === 'unblocked'),
      `Invalid blocker state transition: ${w.state} -> ${v.state}`
    );
    let C = new Map(m.blockers);
    C.set(d, v), pe({ blockers: C });
  }
  function jr({ currentLocation: d, nextLocation: v, historyAction: w }) {
    if (J.size === 0) return;
    J.size > 1 && ie(!1, 'A router only supports one blocker at a time');
    let C = Array.from(J.entries()),
      [P, O] = C[C.length - 1],
      A = m.blockers.get(P);
    if (
      !(A && A.state === 'proceeding') &&
      O({ currentLocation: d, nextLocation: v, historyAction: w })
    )
      return P;
  }
  function Yt(d) {
    let v = Se(404, { pathname: d }),
      w = l || s,
      { matches: C, route: P } = St(w);
    return { notFoundMatches: C, route: P, error: v };
  }
  function Ca(d, v, w) {
    if (((E = d), (R = v), (L = w || null), !x && m.navigation === qt)) {
      x = !0;
      let C = Ur(m.location, m.matches);
      C != null && pe({ restoreScrollPosition: C });
    }
    return () => {
      (E = null), (R = null), (L = null);
    };
  }
  function Hr(d, v) {
    return (
      (L &&
        L(
          d,
          v.map((C) => Pn(C, m.loaderData))
        )) ||
      d.key
    );
  }
  function La(d, v) {
    if (E && R) {
      let w = Hr(d, v);
      E[w] = R();
    }
  }
  function Ur(d, v) {
    if (E) {
      let w = Hr(d, v),
        C = E[w];
      if (typeof C == 'number') return C;
    }
    return null;
  }
  function gt(d, v, w) {
    if (e.patchRoutesOnNavigation)
      if (d) {
        if (Object.keys(d[0].params).length > 0)
          return { active: !0, matches: st(v, w, u, !0) };
      } else return { active: !0, matches: st(v, w, u, !0) || [] };
    return { active: !1, matches: null };
  }
  async function wt(d, v, w, C) {
    if (!e.patchRoutesOnNavigation) return { type: 'success', matches: d };
    let P = d;
    for (;;) {
      let O = l == null,
        A = l || s,
        _ = i;
      try {
        await e.patchRoutesOnNavigation({
          signal: w,
          path: v,
          matches: P,
          fetcherKey: C,
          patch: ($, F) => {
            w.aborted || an($, F, A, _, o, !1);
          },
        });
      } catch ($) {
        return { type: 'error', error: $, partialMatches: P };
      } finally {
        O && !w.aborted && (s = [...s]);
      }
      if (w.aborted) return { type: 'aborted' };
      let N = Ae(A, v, u),
        j = null;
      if (N) {
        if (Object.keys(N[0].params).length === 0)
          return { type: 'success', matches: N };
        if (
          ((j = st(A, v, u, !0)),
          !(j && P.length < j.length && zr(P, j.slice(0, P.length))))
        )
          return { type: 'success', matches: N };
      }
      if ((j || (j = st(A, v, u, !0)), !j || zr(P, j)))
        return { type: 'success', matches: null };
      P = j;
    }
  }
  function zr(d, v) {
    return (
      d.length === v.length && d.every((w, C) => w.route.id === v[C].route.id)
    );
  }
  function Pa(d) {
    (i = {}), (l = ct(d, o, void 0, i));
  }
  function Ma(d, v, w = !1) {
    let C = l == null;
    an(d, v, l || s, i, o, w), C && ((s = [...s]), pe({}));
  }
  return (
    (k = {
      get basename() {
        return u;
      },
      get future() {
        return c;
      },
      get state() {
        return m;
      },
      get routes() {
        return s;
      },
      get window() {
        return t;
      },
      initialize: me,
      subscribe: ma,
      enableScrollRestoration: Ca,
      navigate: _r,
      fetch: wa,
      revalidate: pa,
      createHref: (d) => e.history.createHref(d),
      encodeLocation: (d) => e.history.encodeLocation(d),
      getFetcher: Nr,
      resetFetcher: ba,
      deleteFetcher: Sa,
      dispose: zt,
      getBlocker: xa,
      deleteBlocker: Fr,
      patchRoutes: Ma,
      _internalFetchControllers: ee,
      _internalSetRoutes: Pa,
      _internalSetStateDoNotUseOrYouWillBreakYourApp(d) {
        pe(d);
      },
    }),
    e.unstable_instrumentations &&
      (k = po(
        k,
        e.unstable_instrumentations.map((d) => d.router).filter(Boolean)
      )),
    k
  );
}
function Po(e) {
  return (
    e != null &&
    (('formData' in e && e.formData != null) ||
      ('body' in e && e.body !== void 0))
  );
}
function nr(e, t, r, n, a, o) {
  let i, s;
  if (a) {
    i = [];
    for (let u of t)
      if ((i.push(u), u.route.id === a)) {
        s = u;
        break;
      }
  } else (i = t), (s = t[t.length - 1]);
  let l = pr(n || '.', mr(i), Ee(e.pathname, r) || e.pathname, o === 'path');
  if (
    (n == null && ((l.search = e.search), (l.hash = e.hash)),
    (n == null || n === '' || n === '.') && s)
  ) {
    let u = gr(l.search);
    if (s.route.index && !u)
      l.search = l.search ? l.search.replace(/^\?/, '?index&') : '?index';
    else if (!s.route.index && u) {
      let h = new URLSearchParams(l.search),
        c = h.getAll('index');
      h.delete('index'),
        c.filter((g) => g).forEach((g) => h.append('index', g));
      let y = h.toString();
      l.search = y ? `?${y}` : '';
    }
  }
  return (
    r !== '/' && (l.pathname = ao({ basename: r, pathname: l.pathname })), Pe(l)
  );
}
function rn(e, t, r) {
  if (!r || !Po(r)) return { path: t };
  if (r.formMethod && !Wo(r.formMethod))
    return { path: t, error: Se(405, { method: r.formMethod }) };
  let n = () => ({ path: t, error: Se(400, { type: 'invalid-body' }) }),
    o = (r.formMethod || 'get').toUpperCase(),
    i = Un(t);
  if (r.body !== void 0) {
    if (r.formEncType === 'text/plain') {
      if (!ve(o)) return n();
      let c =
        typeof r.body == 'string'
          ? r.body
          : r.body instanceof FormData || r.body instanceof URLSearchParams
            ? Array.from(r.body.entries()).reduce(
                (y, [g, E]) => `${y}${g}=${E}
`,
                ''
              )
            : String(r.body);
      return {
        path: t,
        submission: {
          formMethod: o,
          formAction: i,
          formEncType: r.formEncType,
          formData: void 0,
          json: void 0,
          text: c,
        },
      };
    } else if (r.formEncType === 'application/json') {
      if (!ve(o)) return n();
      try {
        let c = typeof r.body == 'string' ? JSON.parse(r.body) : r.body;
        return {
          path: t,
          submission: {
            formMethod: o,
            formAction: i,
            formEncType: r.formEncType,
            formData: void 0,
            json: c,
            text: void 0,
          },
        };
      } catch {
        return n();
      }
    }
  }
  V(
    typeof FormData == 'function',
    'FormData is not available in this environment'
  );
  let s, l;
  if (r.formData) (s = ir(r.formData)), (l = r.formData);
  else if (r.body instanceof FormData) (s = ir(r.body)), (l = r.body);
  else if (r.body instanceof URLSearchParams) (s = r.body), (l = cn(s));
  else if (r.body == null) (s = new URLSearchParams()), (l = new FormData());
  else
    try {
      (s = new URLSearchParams(r.body)), (l = cn(s));
    } catch {
      return n();
    }
  let u = {
    formMethod: o,
    formAction: i,
    formEncType: (r && r.formEncType) || 'application/x-www-form-urlencoded',
    formData: l,
    json: void 0,
    text: void 0,
  };
  if (ve(u.formMethod)) return { path: t, submission: u };
  let h = $e(t);
  return (
    e && h.search && gr(h.search) && s.append('index', ''),
    (h.search = `?${s}`),
    { path: Pe(h), submission: u }
  );
}
function nn(e, t, r, n, a, o, i, s, l, u, h, c, y, g, E, L, R, x, b, T) {
  let M = T ? (we(T[1]) ? T[1].error : T[1].data) : void 0,
    D = a.createURL(o.location),
    k = a.createURL(l),
    m;
  if (h && o.errors) {
    let q = Object.keys(o.errors)[0];
    m = i.findIndex((ne) => ne.route.id === q);
  } else if (T && we(T[1])) {
    let q = T[0];
    m = i.findIndex((ne) => ne.route.id === q) - 1;
  }
  let B = T ? T[1].statusCode : void 0,
    W = B && B >= 400,
    G = {
      currentUrl: D,
      currentParams: o.matches[0]?.params || {},
      nextUrl: k,
      nextParams: i[0].params,
      ...s,
      actionResult: M,
      actionStatus: B,
    },
    U = ft(i),
    se = i.map((q, ne) => {
      let { route: te } = q,
        ue = null;
      if (
        (m != null && ne > m
          ? (ue = !1)
          : te.lazy
            ? (ue = !0)
            : yr(te)
              ? h
                ? (ue = ar(te, o.loaderData, o.errors))
                : Mo(o.loaderData, o.matches[ne], q) && (ue = !0)
              : (ue = !1),
        ue !== null)
      )
        return or(r, n, e, U, q, u, t, ue);
      let ee = W
          ? !1
          : c ||
            D.pathname + D.search === k.pathname + k.search ||
            D.search !== k.search ||
            To(o.matches[ne], q),
        fe = { ...G, defaultShouldRevalidate: ee },
        be = Nt(q, fe);
      return or(r, n, e, U, q, u, t, be, fe);
    }),
    Z = [];
  return (
    E.forEach((q, ne) => {
      if (h || !i.some((I) => I.route.id === q.routeId) || g.has(ne)) return;
      let te = o.fetchers.get(ne),
        ue = te && te.state !== 'idle' && te.data === void 0,
        ee = Ae(R, q.path, x);
      if (!ee) {
        if (b && ue) return;
        Z.push({
          key: ne,
          routeId: q.routeId,
          path: q.path,
          matches: null,
          match: null,
          request: null,
          controller: null,
        });
        return;
      }
      if (L.has(ne)) return;
      let fe = Tt(ee, q.path),
        be = new AbortController(),
        p = Xe(a, q.path, be.signal),
        S = null;
      if (y.has(ne)) y.delete(ne), (S = qe(r, n, p, ee, fe, u, t));
      else if (ue) c && (S = qe(r, n, p, ee, fe, u, t));
      else {
        let I = { ...G, defaultShouldRevalidate: W ? !1 : c };
        Nt(fe, I) && (S = qe(r, n, p, ee, fe, u, t, I));
      }
      S &&
        Z.push({
          key: ne,
          routeId: q.routeId,
          path: q.path,
          matches: S,
          match: fe,
          request: p,
          controller: be,
        });
    }),
    { dsMatches: se, revalidatingFetchers: Z }
  );
}
function yr(e) {
  return e.loader != null || (e.middleware != null && e.middleware.length > 0);
}
function ar(e, t, r) {
  if (e.lazy) return !0;
  if (!yr(e)) return !1;
  let n = t != null && e.id in t,
    a = r != null && r[e.id] !== void 0;
  return !n && a
    ? !1
    : typeof e.loader == 'function' && e.loader.hydrate === !0
      ? !0
      : !n && !a;
}
function Mo(e, t, r) {
  let n = !t || r.route.id !== t.route.id,
    a = !e.hasOwnProperty(r.route.id);
  return n || a;
}
function To(e, t) {
  let r = e.route.path;
  return (
    e.pathname !== t.pathname ||
    (r != null && r.endsWith('*') && e.params['*'] !== t.params['*'])
  );
}
function Nt(e, t) {
  if (e.route.shouldRevalidate) {
    let r = e.route.shouldRevalidate(t);
    if (typeof r == 'boolean') return r;
  }
  return t.defaultShouldRevalidate;
}
function an(e, t, r, n, a, o) {
  let i;
  if (e) {
    let u = n[e];
    V(u, `No route found to patch children into: routeId = ${e}`),
      u.children || (u.children = []),
      (i = u.children);
  } else i = r;
  let s = [],
    l = [];
  if (
    (t.forEach((u) => {
      let h = i.find((c) => In(u, c));
      h ? l.push({ existingRoute: h, newRoute: u }) : s.push(u);
    }),
    s.length > 0)
  ) {
    let u = ct(s, a, [e || '_', 'patch', String(i?.length || '0')], n);
    i.push(...u);
  }
  if (o && l.length > 0)
    for (let u = 0; u < l.length; u++) {
      let { existingRoute: h, newRoute: c } = l[u],
        y = h,
        [g] = ct([c], a, [], {}, !0);
      Object.assign(y, {
        element: g.element ? g.element : y.element,
        errorElement: g.errorElement ? g.errorElement : y.errorElement,
        hydrateFallbackElement: g.hydrateFallbackElement
          ? g.hydrateFallbackElement
          : y.hydrateFallbackElement,
      });
    }
}
function In(e, t) {
  return 'id' in e && 'id' in t && e.id === t.id
    ? !0
    : e.index === t.index &&
        e.path === t.path &&
        e.caseSensitive === t.caseSensitive
      ? (!e.children || e.children.length === 0) &&
        (!t.children || t.children.length === 0)
        ? !0
        : e.children.every((r, n) => t.children?.some((a) => In(r, a)))
      : !1;
}
var on = new WeakMap(),
  $n = ({ key: e, route: t, manifest: r, mapRouteProperties: n }) => {
    let a = r[t.id];
    if (
      (V(a, 'No route found in manifest'), !a.lazy || typeof a.lazy != 'object')
    )
      return;
    let o = a.lazy[e];
    if (!o) return;
    let i = on.get(a);
    i || ((i = {}), on.set(a, i));
    let s = i[e];
    if (s) return s;
    let l = (async () => {
      let u = Ba(e),
        c = a[e] !== void 0 && e !== 'hasErrorBoundary';
      if (u)
        ie(
          !u,
          'Route property ' +
            e +
            ' is not a supported lazy route property. This property will be ignored.'
        ),
          (i[e] = Promise.resolve());
      else if (c)
        ie(
          !1,
          `Route "${a.id}" has a static property "${e}" defined. The lazy property will be ignored.`
        );
      else {
        let y = await o();
        y != null && (Object.assign(a, { [e]: y }), Object.assign(a, n(a)));
      }
      typeof a.lazy == 'object' &&
        ((a.lazy[e] = void 0),
        Object.values(a.lazy).every((y) => y === void 0) && (a.lazy = void 0));
    })();
    return (i[e] = l), l;
  },
  ln = new WeakMap();
function Do(e, t, r, n, a) {
  let o = r[e.id];
  if ((V(o, 'No route found in manifest'), !e.lazy))
    return { lazyRoutePromise: void 0, lazyHandlerPromise: void 0 };
  if (typeof e.lazy == 'function') {
    let h = ln.get(o);
    if (h) return { lazyRoutePromise: h, lazyHandlerPromise: h };
    let c = (async () => {
      V(typeof e.lazy == 'function', 'No lazy route function found');
      let y = await e.lazy(),
        g = {};
      for (let E in y) {
        let L = y[E];
        if (L === void 0) continue;
        let R = Ya(E),
          b = o[E] !== void 0 && E !== 'hasErrorBoundary';
        R
          ? ie(
              !R,
              'Route property ' +
                E +
                ' is not a supported property to be returned from a lazy route function. This property will be ignored.'
            )
          : b
            ? ie(
                !b,
                `Route "${o.id}" has a static property "${E}" defined but its lazy function is also returning a value for this property. The lazy route property "${E}" will be ignored.`
              )
            : (g[E] = L);
      }
      Object.assign(o, g), Object.assign(o, { ...n(o), lazy: void 0 });
    })();
    return (
      ln.set(o, c),
      c.catch(() => {}),
      { lazyRoutePromise: c, lazyHandlerPromise: c }
    );
  }
  let i = Object.keys(e.lazy),
    s = [],
    l;
  for (let h of i) {
    if (a && a.includes(h)) continue;
    let c = $n({ key: h, route: e, manifest: r, mapRouteProperties: n });
    c && (s.push(c), h === t && (l = c));
  }
  let u = s.length > 0 ? Promise.all(s).then(() => {}) : void 0;
  return (
    u?.catch(() => {}),
    l?.catch(() => {}),
    { lazyRoutePromise: u, lazyHandlerPromise: l }
  );
}
async function sn(e) {
  let t = e.matches.filter((a) => a.shouldLoad),
    r = {};
  return (
    (await Promise.all(t.map((a) => a.resolve()))).forEach((a, o) => {
      r[t[o].route.id] = a;
    }),
    r
  );
}
async function _o(e) {
  return e.matches.some((t) => t.route.middleware) ? Fn(e, () => sn(e)) : sn(e);
}
function Fn(e, t) {
  return Oo(e, t, (n) => n, Uo, r);
  function r(n, a, o) {
    if (o)
      return Promise.resolve(
        Object.assign(o.value, { [a]: { type: 'error', result: n } })
      );
    {
      let { matches: i } = e,
        s = Math.min(
          Math.max(
            i.findIndex((u) => u.route.id === a),
            0
          ),
          Math.max(
            i.findIndex((u) => u.shouldCallHandler()),
            0
          )
        ),
        l = ke(i, i[s].route.id).route.id;
      return Promise.resolve({ [l]: { type: 'error', result: n } });
    }
  }
}
async function Oo(e, t, r, n, a) {
  let {
      matches: o,
      request: i,
      params: s,
      context: l,
      unstable_pattern: u,
    } = e,
    h = o.flatMap((y) =>
      y.route.middleware ? y.route.middleware.map((g) => [y.route.id, g]) : []
    );
  return await jn(
    { request: i, params: s, context: l, unstable_pattern: u },
    h,
    t,
    r,
    n,
    a
  );
}
async function jn(e, t, r, n, a, o, i = 0) {
  let { request: s } = e;
  if (s.signal.aborted)
    throw s.signal.reason ?? new Error(`Request aborted: ${s.method} ${s.url}`);
  let l = t[i];
  if (!l) return await r();
  let [u, h] = l,
    c,
    y = async () => {
      if (c) throw new Error('You may only call `next()` once per middleware');
      try {
        return (c = { value: await jn(e, t, r, n, a, o, i + 1) }), c.value;
      } catch (g) {
        return (c = { value: await o(g, u, c) }), c.value;
      }
    };
  try {
    let g = await h(e, y),
      E = g != null ? n(g) : void 0;
    return a(E)
      ? E
      : c
        ? (E ?? c.value)
        : ((c = { value: await y() }), c.value);
  } catch (g) {
    return await o(g, u, c);
  }
}
function Hn(e, t, r, n, a) {
  let o = $n({
      key: 'middleware',
      route: n.route,
      manifest: t,
      mapRouteProperties: e,
    }),
    i = Do(n.route, ve(r.method) ? 'action' : 'loader', t, e, a);
  return {
    middleware: o,
    route: i.lazyRoutePromise,
    handler: i.lazyHandlerPromise,
  };
}
function or(e, t, r, n, a, o, i, s, l = null) {
  let u = !1,
    h = Hn(e, t, r, a, o);
  return {
    ...a,
    _lazyPromises: h,
    shouldLoad: s,
    shouldRevalidateArgs: l,
    shouldCallHandler(c) {
      return (
        (u = !0),
        l
          ? typeof c == 'boolean'
            ? Nt(a, { ...l, defaultShouldRevalidate: c })
            : Nt(a, l)
          : s
      );
    },
    resolve(c) {
      let { lazy: y, loader: g, middleware: E } = a.route,
        L = u || s || (c && !ve(r.method) && (y || g)),
        R = E && E.length > 0 && !g && !y;
      return L && (ve(r.method) || !R)
        ? No({
            request: r,
            unstable_pattern: n,
            match: a,
            lazyHandlerPromise: h?.handler,
            lazyRoutePromise: h?.route,
            handlerOverride: c,
            scopedContext: i,
          })
        : Promise.resolve({ type: 'data', result: void 0 });
    },
  };
}
function qe(e, t, r, n, a, o, i, s = null) {
  return n.map((l) =>
    l.route.id !== a.route.id
      ? {
          ...l,
          shouldLoad: !1,
          shouldRevalidateArgs: s,
          shouldCallHandler: () => !1,
          _lazyPromises: Hn(e, t, r, l, o),
          resolve: () => Promise.resolve({ type: 'data', result: void 0 }),
        }
      : or(e, t, r, ft(n), l, o, i, !0, s)
  );
}
async function Ao(e, t, r, n, a, o) {
  r.some((u) => u._lazyPromises?.middleware) &&
    (await Promise.all(r.map((u) => u._lazyPromises?.middleware)));
  let i = {
      request: t,
      unstable_pattern: ft(r),
      params: r[0].params,
      context: a,
      matches: r,
    },
    l = await e({
      ...i,
      fetcherKey: n,
      runClientMiddleware: (u) => {
        let h = i;
        return Fn(h, () =>
          u({
            ...h,
            fetcherKey: n,
            runClientMiddleware: () => {
              throw new Error(
                'Cannot call `runClientMiddleware()` from within an `runClientMiddleware` handler'
              );
            },
          })
        );
      },
    });
  try {
    await Promise.all(
      r.flatMap((u) => [u._lazyPromises?.handler, u._lazyPromises?.route])
    );
  } catch {}
  return l;
}
async function No({
  request: e,
  unstable_pattern: t,
  match: r,
  lazyHandlerPromise: n,
  lazyRoutePromise: a,
  handlerOverride: o,
  scopedContext: i,
}) {
  let s,
    l,
    u = ve(e.method),
    h = u ? 'action' : 'loader',
    c = (y) => {
      let g,
        E = new Promise((x, b) => (g = b));
      (l = () => g()), e.signal.addEventListener('abort', l);
      let L = (x) =>
          typeof y != 'function'
            ? Promise.reject(
                new Error(
                  `You cannot call the handler for a route which defines a boolean "${h}" [routeId: ${r.route.id}]`
                )
              )
            : y(
                {
                  request: e,
                  unstable_pattern: t,
                  params: r.params,
                  context: i,
                },
                ...(x !== void 0 ? [x] : [])
              ),
        R = (async () => {
          try {
            return { type: 'data', result: await (o ? o((b) => L(b)) : L()) };
          } catch (x) {
            return { type: 'error', result: x };
          }
        })();
      return Promise.race([R, E]);
    };
  try {
    let y = u ? r.route.action : r.route.loader;
    if (n || a)
      if (y) {
        let g,
          [E] = await Promise.all([
            c(y).catch((L) => {
              g = L;
            }),
            n,
            a,
          ]);
        if (g !== void 0) throw g;
        s = E;
      } else {
        await n;
        let g = u ? r.route.action : r.route.loader;
        if (g) [s] = await Promise.all([c(g), a]);
        else if (h === 'action') {
          let E = new URL(e.url),
            L = E.pathname + E.search;
          throw Se(405, { method: e.method, pathname: L, routeId: r.route.id });
        } else return { type: 'data', result: void 0 };
      }
    else if (y) s = await c(y);
    else {
      let g = new URL(e.url),
        E = g.pathname + g.search;
      throw Se(404, { pathname: E });
    }
  } catch (y) {
    return { type: 'error', result: y };
  } finally {
    l && e.signal.removeEventListener('abort', l);
  }
  return s;
}
async function ko(e) {
  let t = e.headers.get('Content-Type');
  return t && /\bapplication\/json\b/.test(t)
    ? e.body == null
      ? null
      : e.json()
    : e.text();
}
async function Io(e) {
  let { result: t, type: r } = e;
  if (vr(t)) {
    let n;
    try {
      n = await ko(t);
    } catch (a) {
      return { type: 'error', error: a };
    }
    return r === 'error'
      ? {
          type: 'error',
          error: new Ye(t.status, t.statusText, n),
          statusCode: t.status,
          headers: t.headers,
        }
      : { type: 'data', data: n, statusCode: t.status, headers: t.headers };
  }
  return r === 'error'
    ? lr(t)
      ? t.data instanceof Error
        ? {
            type: 'error',
            error: t.data,
            statusCode: t.init?.status,
            headers: t.init?.headers ? new Headers(t.init.headers) : void 0,
          }
        : {
            type: 'error',
            error: Ho(t),
            statusCode: We(t) ? t.status : void 0,
            headers: t.init?.headers ? new Headers(t.init.headers) : void 0,
          }
      : { type: 'error', error: t, statusCode: We(t) ? t.status : void 0 }
    : lr(t)
      ? {
          type: 'data',
          data: t.data,
          statusCode: t.init?.status,
          headers: t.init?.headers ? new Headers(t.init.headers) : void 0,
        }
      : { type: 'data', data: t };
}
function $o(e, t, r, n, a) {
  let o = e.headers.get('Location');
  if (
    (V(
      o,
      'Redirects returned/thrown from loaders/actions must have a Location header'
    ),
    !$t(o))
  ) {
    let i = n.slice(0, n.findIndex((s) => s.route.id === r) + 1);
    (o = nr(new URL(t.url), i, a, o)), e.headers.set('Location', o);
  }
  return e;
}
function un(e, t, r) {
  if ($t(e)) {
    let n = e,
      a = n.startsWith('//') ? new URL(t.protocol + n) : new URL(n),
      o = Ee(a.pathname, r) != null;
    if (a.origin === t.origin && o) return a.pathname + a.search + a.hash;
  }
  return e;
}
function Xe(e, t, r, n) {
  let a = e.createURL(Un(t)).toString(),
    o = { signal: r };
  if (n && ve(n.formMethod)) {
    let { formMethod: i, formEncType: s } = n;
    (o.method = i.toUpperCase()),
      s === 'application/json'
        ? ((o.headers = new Headers({ 'Content-Type': s })),
          (o.body = JSON.stringify(n.json)))
        : s === 'text/plain'
          ? (o.body = n.text)
          : s === 'application/x-www-form-urlencoded' && n.formData
            ? (o.body = ir(n.formData))
            : (o.body = n.formData);
  }
  return new Request(a, o);
}
function ir(e) {
  let t = new URLSearchParams();
  for (let [r, n] of e.entries())
    t.append(r, typeof n == 'string' ? n : n.name);
  return t;
}
function cn(e) {
  let t = new FormData();
  for (let [r, n] of e.entries()) t.append(r, n);
  return t;
}
function Fo(e, t, r, n = !1, a = !1) {
  let o = {},
    i = null,
    s,
    l = !1,
    u = {},
    h = r && we(r[1]) ? r[1].error : void 0;
  return (
    e.forEach((c) => {
      if (!(c.route.id in t)) return;
      let y = c.route.id,
        g = t[y];
      if (
        (V(!Be(g), 'Cannot handle redirect results in processLoaderData'),
        we(g))
      ) {
        let E = g.error;
        if ((h !== void 0 && ((E = h), (h = void 0)), (i = i || {}), a))
          i[y] = E;
        else {
          let L = ke(e, y);
          i[L.route.id] == null && (i[L.route.id] = E);
        }
        n || (o[y] = kn),
          l || ((l = !0), (s = We(g.error) ? g.error.status : 500)),
          g.headers && (u[y] = g.headers);
      } else
        (o[y] = g.data),
          g.statusCode && g.statusCode !== 200 && !l && (s = g.statusCode),
          g.headers && (u[y] = g.headers);
    }),
    h !== void 0 && r && ((i = { [r[0]]: h }), r[2] && (o[r[2]] = void 0)),
    { loaderData: o, errors: i, statusCode: s || 200, loaderHeaders: u }
  );
}
function dn(e, t, r, n, a, o) {
  let { loaderData: i, errors: s } = Fo(t, r, n);
  return (
    a
      .filter((l) => !l.matches || l.matches.some((u) => u.shouldLoad))
      .forEach((l) => {
        let { key: u, match: h, controller: c } = l;
        if (c && c.signal.aborted) return;
        let y = o[u];
        if ((V(y, 'Did not find corresponding fetcher result'), we(y))) {
          let g = ke(e.matches, h?.route.id);
          (s && s[g.route.id]) || (s = { ...s, [g.route.id]: y.error }),
            e.fetchers.delete(u);
        } else if (Be(y)) V(!1, 'Unhandled fetcher revalidation redirect');
        else {
          let g = Oe(y.data);
          e.fetchers.set(u, g);
        }
      }),
    { loaderData: i, errors: s }
  );
}
function fn(e, t, r, n) {
  let a = Object.entries(t)
    .filter(([, o]) => o !== kn)
    .reduce((o, [i, s]) => ((o[i] = s), o), {});
  for (let o of r) {
    let i = o.route.id;
    if (
      (!t.hasOwnProperty(i) &&
        e.hasOwnProperty(i) &&
        o.route.loader &&
        (a[i] = e[i]),
      n && n.hasOwnProperty(i))
    )
      break;
  }
  return a;
}
function hn(e) {
  return e
    ? we(e[1])
      ? { actionData: {} }
      : { actionData: { [e[0]]: e[1].data } }
    : {};
}
function ke(e, t) {
  return (
    (t ? e.slice(0, e.findIndex((n) => n.route.id === t) + 1) : [...e])
      .reverse()
      .find((n) => n.route.hasErrorBoundary === !0) || e[0]
  );
}
function St(e) {
  let t =
    e.length === 1
      ? e[0]
      : e.find((r) => r.index || !r.path || r.path === '/') || {
          id: '__shim-error-route__',
        };
  return {
    matches: [{ params: {}, pathname: '', pathnameBase: '', route: t }],
    route: t,
  };
}
function Se(
  e,
  { pathname: t, routeId: r, method: n, type: a, message: o } = {}
) {
  let i = 'Unknown Server Error',
    s = 'Unknown @remix-run/router error';
  return (
    e === 400
      ? ((i = 'Bad Request'),
        n && t && r
          ? (s = `You made a ${n} request to "${t}" but did not provide a \`loader\` for route "${r}", so there is no way to handle the request.`)
          : a === 'invalid-body' && (s = 'Unable to encode submission body'))
      : e === 403
        ? ((i = 'Forbidden'), (s = `Route "${r}" does not match URL "${t}"`))
        : e === 404
          ? ((i = 'Not Found'), (s = `No route matches URL "${t}"`))
          : e === 405 &&
            ((i = 'Method Not Allowed'),
            n && t && r
              ? (s = `You made a ${n.toUpperCase()} request to "${t}" but did not provide an \`action\` for route "${r}", so there is no way to handle the request.`)
              : n && (s = `Invalid request method "${n.toUpperCase()}"`)),
    new Ye(e || 500, i, new Error(s), !0)
  );
}
function xt(e) {
  let t = Object.entries(e);
  for (let r = t.length - 1; r >= 0; r--) {
    let [n, a] = t[r];
    if (Be(a)) return { key: n, result: a };
  }
}
function Un(e) {
  let t = typeof e == 'string' ? $e(e) : e;
  return Pe({ ...t, hash: '' });
}
function jo(e, t) {
  return e.pathname !== t.pathname || e.search !== t.search
    ? !1
    : e.hash === ''
      ? t.hash !== ''
      : e.hash === t.hash
        ? !0
        : t.hash !== '';
}
function Ho(e) {
  return new Ye(
    e.init?.status ?? 500,
    e.init?.statusText ?? 'Internal Server Error',
    e.data
  );
}
function Uo(e) {
  return (
    e != null &&
    typeof e == 'object' &&
    Object.entries(e).every(([t, r]) => typeof t == 'string' && zo(r))
  );
}
function zo(e) {
  return (
    e != null &&
    typeof e == 'object' &&
    'type' in e &&
    'result' in e &&
    (e.type === 'data' || e.type === 'error')
  );
}
function Bo(e) {
  return vr(e.result) && So.has(e.result.status);
}
function we(e) {
  return e.type === 'error';
}
function Be(e) {
  return (e && e.type) === 'redirect';
}
function lr(e) {
  return (
    typeof e == 'object' &&
    e != null &&
    'type' in e &&
    'data' in e &&
    'init' in e &&
    e.type === 'DataWithResponseInit'
  );
}
function vr(e) {
  return (
    e != null &&
    typeof e.status == 'number' &&
    typeof e.statusText == 'string' &&
    typeof e.headers == 'object' &&
    typeof e.body < 'u'
  );
}
function Wo(e) {
  return bo.has(e.toUpperCase());
}
function ve(e) {
  return Eo.has(e.toUpperCase());
}
function gr(e) {
  return new URLSearchParams(e).getAll('index').some((t) => t === '');
}
function Tt(e, t) {
  let r = typeof t == 'string' ? $e(t).search : t.search;
  if (e[e.length - 1].route.index && gr(r || '')) return e[e.length - 1];
  let n = _n(e);
  return n[n.length - 1];
}
function mn(e) {
  let {
    formMethod: t,
    formAction: r,
    formEncType: n,
    text: a,
    formData: o,
    json: i,
  } = e;
  if (!(!t || !r || !n)) {
    if (a != null)
      return {
        formMethod: t,
        formAction: r,
        formEncType: n,
        formData: void 0,
        json: void 0,
        text: a,
      };
    if (o != null)
      return {
        formMethod: t,
        formAction: r,
        formEncType: n,
        formData: o,
        json: void 0,
        text: void 0,
      };
    if (i !== void 0)
      return {
        formMethod: t,
        formAction: r,
        formEncType: n,
        formData: void 0,
        json: i,
        text: void 0,
      };
  }
}
function Qt(e, t) {
  return t
    ? {
        state: 'loading',
        location: e,
        formMethod: t.formMethod,
        formAction: t.formAction,
        formEncType: t.formEncType,
        formData: t.formData,
        json: t.json,
        text: t.text,
      }
    : {
        state: 'loading',
        location: e,
        formMethod: void 0,
        formAction: void 0,
        formEncType: void 0,
        formData: void 0,
        json: void 0,
        text: void 0,
      };
}
function Yo(e, t) {
  return {
    state: 'submitting',
    location: e,
    formMethod: t.formMethod,
    formAction: t.formAction,
    formEncType: t.formEncType,
    formData: t.formData,
    json: t.json,
    text: t.text,
  };
}
function ot(e, t) {
  return e
    ? {
        state: 'loading',
        formMethod: e.formMethod,
        formAction: e.formAction,
        formEncType: e.formEncType,
        formData: e.formData,
        json: e.json,
        text: e.text,
        data: t,
      }
    : {
        state: 'loading',
        formMethod: void 0,
        formAction: void 0,
        formEncType: void 0,
        formData: void 0,
        json: void 0,
        text: void 0,
        data: t,
      };
}
function Vo(e, t) {
  return {
    state: 'submitting',
    formMethod: e.formMethod,
    formAction: e.formAction,
    formEncType: e.formEncType,
    formData: e.formData,
    json: e.json,
    text: e.text,
    data: t ? t.data : void 0,
  };
}
function Oe(e) {
  return {
    state: 'idle',
    formMethod: void 0,
    formAction: void 0,
    formEncType: void 0,
    formData: void 0,
    json: void 0,
    text: void 0,
    data: e,
  };
}
function Jo(e, t) {
  try {
    let r = e.sessionStorage.getItem(Nn);
    if (r) {
      let n = JSON.parse(r);
      for (let [a, o] of Object.entries(n || {}))
        o && Array.isArray(o) && t.set(a, new Set(o || []));
    }
  } catch {}
}
function Go(e, t) {
  if (t.size > 0) {
    let r = {};
    for (let [n, a] of t) r[n] = [...a];
    try {
      e.sessionStorage.setItem(Nn, JSON.stringify(r));
    } catch (n) {
      ie(
        !1,
        `Failed to save applied view transitions in sessionStorage (${n}).`
      );
    }
  }
}
function pn() {
  let e,
    t,
    r = new Promise((n, a) => {
      (e = async (o) => {
        n(o);
        try {
          await r;
        } catch {}
      }),
        (t = async (o) => {
          a(o);
          try {
            await r;
          } catch {}
        });
    });
  return { promise: r, resolve: e, reject: t };
}
var Ve = f.createContext(null);
Ve.displayName = 'DataRouter';
var Qe = f.createContext(null);
Qe.displayName = 'DataRouterState';
var Xo = f.createContext(!1);
function Ko() {
  return f.useContext(Xo);
}
var wr = f.createContext({ isTransitioning: !1 });
wr.displayName = 'ViewTransition';
var zn = f.createContext(new Map());
zn.displayName = 'Fetchers';
var qo = f.createContext(null);
qo.displayName = 'Await';
var Re = f.createContext(null);
Re.displayName = 'Navigation';
var Ft = f.createContext(null);
Ft.displayName = 'Location';
var xe = f.createContext({ outlet: null, matches: [], isDataRoute: !1 });
xe.displayName = 'Route';
var Er = f.createContext(null);
Er.displayName = 'RouteError';
function Qo(e, { relative: t } = {}) {
  V(ht(), 'useHref() may be used only in the context of a <Router> component.');
  let { basename: r, navigator: n } = f.useContext(Re),
    { hash: a, pathname: o, search: i } = mt(e, { relative: t }),
    s = o;
  return (
    r !== '/' && (s = o === '/' ? r : Le([r, o])),
    n.createHref({ pathname: s, search: i, hash: a })
  );
}
function ht() {
  return f.useContext(Ft) != null;
}
function Me() {
  return (
    V(
      ht(),
      'useLocation() may be used only in the context of a <Router> component.'
    ),
    f.useContext(Ft).location
  );
}
var Bn =
  'You should call navigate() in a React.useEffect(), not when your component is first rendered.';
function Wn(e) {
  f.useContext(Re).static || f.useLayoutEffect(e);
}
function Zo() {
  let { isDataRoute: e } = f.useContext(xe);
  return e ? hi() : ei();
}
function ei() {
  V(
    ht(),
    'useNavigate() may be used only in the context of a <Router> component.'
  );
  let e = f.useContext(Ve),
    { basename: t, navigator: r } = f.useContext(Re),
    { matches: n } = f.useContext(xe),
    { pathname: a } = Me(),
    o = JSON.stringify(mr(n)),
    i = f.useRef(!1);
  return (
    Wn(() => {
      i.current = !0;
    }),
    f.useCallback(
      (l, u = {}) => {
        if ((ie(i.current, Bn), !i.current)) return;
        if (typeof l == 'number') {
          r.go(l);
          return;
        }
        let h = pr(l, JSON.parse(o), a, u.relative === 'path');
        e == null &&
          t !== '/' &&
          (h.pathname = h.pathname === '/' ? t : Le([t, h.pathname])),
          (u.replace ? r.replace : r.push)(h, u.state, u);
      },
      [t, r, o, a, e]
    )
  );
}
var ti = f.createContext(null);
function ri(e) {
  let t = f.useContext(xe).outlet;
  return f.useMemo(
    () => t && f.createElement(ti.Provider, { value: e }, t),
    [t, e]
  );
}
function Yn() {
  let { matches: e } = f.useContext(xe),
    t = e[e.length - 1];
  return t ? t.params : {};
}
function mt(e, { relative: t } = {}) {
  let { matches: r } = f.useContext(xe),
    { pathname: n } = Me(),
    a = JSON.stringify(mr(r));
  return f.useMemo(() => pr(e, JSON.parse(a), n, t === 'path'), [e, a, n, t]);
}
function ni(e, t, r, n, a) {
  V(
    ht(),
    'useRoutes() may be used only in the context of a <Router> component.'
  );
  let { navigator: o } = f.useContext(Re),
    { matches: i } = f.useContext(xe),
    s = i[i.length - 1],
    l = s ? s.params : {},
    u = s ? s.pathname : '/',
    h = s ? s.pathnameBase : '/',
    c = s && s.route;
  {
    let b = (c && c.path) || '';
    Gn(
      u,
      !c || b.endsWith('*') || b.endsWith('*?'),
      `You rendered descendant <Routes> (or called \`useRoutes()\`) at "${u}" (under <Route path="${b}">) but the parent route path has no trailing "*". This means if you navigate deeper, the parent won't match anymore and therefore the child routes will never render.

Please change the parent <Route path="${b}"> to <Route path="${b === '/' ? '*' : `${b}/*`}">.`
    );
  }
  let y = Me(),
    g;
  g = y;
  let E = g.pathname || '/',
    L = E;
  if (h !== '/') {
    let b = h.replace(/^\//, '').split('/');
    L = '/' + E.replace(/^\//, '').split('/').slice(b.length).join('/');
  }
  let R = Ae(e, { pathname: L });
  return (
    ie(
      c || R != null,
      `No routes matched location "${g.pathname}${g.search}${g.hash}" `
    ),
    ie(
      R == null ||
        R[R.length - 1].route.element !== void 0 ||
        R[R.length - 1].route.Component !== void 0 ||
        R[R.length - 1].route.lazy !== void 0,
      `Matched leaf route at location "${g.pathname}${g.search}${g.hash}" does not have an element or Component. This means it will render an <Outlet /> with a null value by default resulting in an "empty" page.`
    ),
    si(
      R &&
        R.map((b) =>
          Object.assign({}, b, {
            params: Object.assign({}, l, b.params),
            pathname: Le([
              h,
              o.encodeLocation
                ? o.encodeLocation(
                    b.pathname.replace(/\?/g, '%3F').replace(/#/g, '%23')
                  ).pathname
                : b.pathname,
            ]),
            pathnameBase:
              b.pathnameBase === '/'
                ? h
                : Le([
                    h,
                    o.encodeLocation
                      ? o.encodeLocation(
                          b.pathnameBase
                            .replace(/\?/g, '%3F')
                            .replace(/#/g, '%23')
                        ).pathname
                      : b.pathnameBase,
                  ]),
          })
        ),
      i,
      r,
      n,
      a
    )
  );
}
function ai() {
  let e = Sr(),
    t = We(e)
      ? `${e.status} ${e.statusText}`
      : e instanceof Error
        ? e.message
        : JSON.stringify(e),
    r = e instanceof Error ? e.stack : null,
    n = 'rgba(200,200,200, 0.5)',
    a = { padding: '0.5rem', backgroundColor: n },
    o = { padding: '2px 4px', backgroundColor: n },
    i = null;
  return (
    console.error('Error handled by React Router default ErrorBoundary:', e),
    (i = f.createElement(
      f.Fragment,
      null,
      f.createElement('p', null, '💿 Hey developer 👋'),
      f.createElement(
        'p',
        null,
        'You can provide a way better UX than this when your app throws errors by providing your own ',
        f.createElement('code', { style: o }, 'ErrorBoundary'),
        ' or',
        ' ',
        f.createElement('code', { style: o }, 'errorElement'),
        ' prop on your route.'
      )
    )),
    f.createElement(
      f.Fragment,
      null,
      f.createElement('h2', null, 'Unexpected Application Error!'),
      f.createElement('h3', { style: { fontStyle: 'italic' } }, t),
      r ? f.createElement('pre', { style: a }, r) : null,
      i
    )
  );
}
var oi = f.createElement(ai, null),
  ii = class extends f.Component {
    constructor(e) {
      super(e),
        (this.state = {
          location: e.location,
          revalidation: e.revalidation,
          error: e.error,
        });
    }
    static getDerivedStateFromError(e) {
      return { error: e };
    }
    static getDerivedStateFromProps(e, t) {
      return t.location !== e.location ||
        (t.revalidation !== 'idle' && e.revalidation === 'idle')
        ? { error: e.error, location: e.location, revalidation: e.revalidation }
        : {
            error: e.error !== void 0 ? e.error : t.error,
            location: t.location,
            revalidation: e.revalidation || t.revalidation,
          };
    }
    componentDidCatch(e, t) {
      this.props.onError
        ? this.props.onError(e, t)
        : console.error(
            'React Router caught the following error during render',
            e
          );
    }
    render() {
      return this.state.error !== void 0
        ? f.createElement(
            xe.Provider,
            { value: this.props.routeContext },
            f.createElement(Er.Provider, {
              value: this.state.error,
              children: this.props.component,
            })
          )
        : this.props.children;
    }
  };
function li({ routeContext: e, match: t, children: r }) {
  let n = f.useContext(Ve);
  return (
    n &&
      n.static &&
      n.staticContext &&
      (t.route.errorElement || t.route.ErrorBoundary) &&
      (n.staticContext._deepestRenderedBoundaryId = t.route.id),
    f.createElement(xe.Provider, { value: e }, r)
  );
}
function si(e, t = [], r = null, n = null, a = null) {
  if (e == null) {
    if (!r) return null;
    if (r.errors) e = r.matches;
    else if (t.length === 0 && !r.initialized && r.matches.length > 0)
      e = r.matches;
    else return null;
  }
  let o = e,
    i = r?.errors;
  if (i != null) {
    let h = o.findIndex((c) => c.route.id && i?.[c.route.id] !== void 0);
    V(
      h >= 0,
      `Could not find a matching route for errors on route IDs: ${Object.keys(i).join(',')}`
    ),
      (o = o.slice(0, Math.min(o.length, h + 1)));
  }
  let s = !1,
    l = -1;
  if (r)
    for (let h = 0; h < o.length; h++) {
      let c = o[h];
      if (
        ((c.route.HydrateFallback || c.route.hydrateFallbackElement) && (l = h),
        c.route.id)
      ) {
        let { loaderData: y, errors: g } = r,
          E =
            c.route.loader &&
            !y.hasOwnProperty(c.route.id) &&
            (!g || g[c.route.id] === void 0);
        if (c.route.lazy || E) {
          (s = !0), l >= 0 ? (o = o.slice(0, l + 1)) : (o = [o[0]]);
          break;
        }
      }
    }
  let u =
    r && n
      ? (h, c) => {
          n(h, {
            location: r.location,
            params: r.matches?.[0]?.params ?? {},
            unstable_pattern: ft(r.matches),
            errorInfo: c,
          });
        }
      : void 0;
  return o.reduceRight((h, c, y) => {
    let g,
      E = !1,
      L = null,
      R = null;
    r &&
      ((g = i && c.route.id ? i[c.route.id] : void 0),
      (L = c.route.errorElement || oi),
      s &&
        (l < 0 && y === 0
          ? (Gn(
              'route-fallback',
              !1,
              'No `HydrateFallback` element provided to render during initial hydration'
            ),
            (E = !0),
            (R = null))
          : l === y &&
            ((E = !0), (R = c.route.hydrateFallbackElement || null))));
    let x = t.concat(o.slice(0, y + 1)),
      b = () => {
        let T;
        return (
          g
            ? (T = L)
            : E
              ? (T = R)
              : c.route.Component
                ? (T = f.createElement(c.route.Component, null))
                : c.route.element
                  ? (T = c.route.element)
                  : (T = h),
          f.createElement(li, {
            match: c,
            routeContext: { outlet: h, matches: x, isDataRoute: r != null },
            children: T,
          })
        );
      };
    return r && (c.route.ErrorBoundary || c.route.errorElement || y === 0)
      ? f.createElement(ii, {
          location: r.location,
          revalidation: r.revalidation,
          component: L,
          error: g,
          children: b(),
          routeContext: { outlet: null, matches: x, isDataRoute: !0 },
          onError: u,
        })
      : b();
  }, null);
}
function Rr(e) {
  return `${e} must be used within a data router.  See https://reactrouter.com/en/main/routers/picking-a-router.`;
}
function ui(e) {
  let t = f.useContext(Ve);
  return V(t, Rr(e)), t;
}
function pt(e) {
  let t = f.useContext(Qe);
  return V(t, Rr(e)), t;
}
function ci(e) {
  let t = f.useContext(xe);
  return V(t, Rr(e)), t;
}
function yt(e) {
  let t = ci(e),
    r = t.matches[t.matches.length - 1];
  return (
    V(r.route.id, `${e} can only be used on routes that contain a unique "id"`),
    r.route.id
  );
}
function di() {
  return yt('useRouteId');
}
function fi() {
  return pt('useNavigation').navigation;
}
function br() {
  let { matches: e, loaderData: t } = pt('useMatches');
  return f.useMemo(() => e.map((r) => Pn(r, t)), [e, t]);
}
function Vn() {
  let e = pt('useLoaderData'),
    t = yt('useLoaderData');
  return e.loaderData[t];
}
function Jn() {
  let e = pt('useActionData'),
    t = yt('useLoaderData');
  return e.actionData ? e.actionData[t] : void 0;
}
function Sr() {
  let e = f.useContext(Er),
    t = pt('useRouteError'),
    r = yt('useRouteError');
  return e !== void 0 ? e : t.errors?.[r];
}
function hi() {
  let { router: e } = ui('useNavigate'),
    t = yt('useNavigate'),
    r = f.useRef(!1);
  return (
    Wn(() => {
      r.current = !0;
    }),
    f.useCallback(
      async (a, o = {}) => {
        ie(r.current, Bn),
          r.current &&
            (typeof a == 'number'
              ? await e.navigate(a)
              : await e.navigate(a, { fromRouteId: t, ...o }));
      },
      [e, t]
    )
  );
}
var yn = {};
function Gn(e, t, r) {
  !t && !yn[e] && ((yn[e] = !0), ie(!1, r));
}
var vn = {};
function sr(e, t) {
  !e && !vn[t] && ((vn[t] = !0), console.warn(t));
}
var mi = 'useOptimistic',
  gn = $a[mi],
  pi = () => {};
function yi(e) {
  return gn ? gn(e) : [e, pi];
}
function Zl(e) {
  let t = {
    hasErrorBoundary:
      e.hasErrorBoundary || e.ErrorBoundary != null || e.errorElement != null,
  };
  return (
    e.Component &&
      (e.element &&
        ie(
          !1,
          'You should not include both `Component` and `element` on your route - `Component` will be used.'
        ),
      Object.assign(t, {
        element: f.createElement(e.Component),
        Component: void 0,
      })),
    e.HydrateFallback &&
      (e.hydrateFallbackElement &&
        ie(
          !1,
          'You should not include both `HydrateFallback` and `hydrateFallbackElement` on your route - `HydrateFallback` will be used.'
        ),
      Object.assign(t, {
        hydrateFallbackElement: f.createElement(e.HydrateFallback),
        HydrateFallback: void 0,
      })),
    e.ErrorBoundary &&
      (e.errorElement &&
        ie(
          !1,
          'You should not include both `ErrorBoundary` and `errorElement` on your route - `ErrorBoundary` will be used.'
        ),
      Object.assign(t, {
        errorElement: f.createElement(e.ErrorBoundary),
        ErrorBoundary: void 0,
      })),
    t
  );
}
var es = ['HydrateFallback', 'hydrateFallbackElement'],
  vi = class {
    constructor() {
      (this.status = 'pending'),
        (this.promise = new Promise((e, t) => {
          (this.resolve = (r) => {
            this.status === 'pending' && ((this.status = 'resolved'), e(r));
          }),
            (this.reject = (r) => {
              this.status === 'pending' && ((this.status = 'rejected'), t(r));
            });
        }));
    }
  };
function ts({
  router: e,
  flushSync: t,
  unstable_onError: r,
  unstable_useTransitions: n,
}) {
  let [a, o] = f.useState(e.state),
    [i, s] = yi(a),
    [l, u] = f.useState(),
    [h, c] = f.useState({ isTransitioning: !1 }),
    [y, g] = f.useState(),
    [E, L] = f.useState(),
    [R, x] = f.useState(),
    b = f.useRef(new Map()),
    T = f.useCallback(
      (
        m,
        {
          deletedFetchers: B,
          newErrors: W,
          flushSync: G,
          viewTransitionOpts: U,
        }
      ) => {
        W &&
          r &&
          Object.values(W).forEach((Z) =>
            r(Z, {
              location: m.location,
              params: m.matches[0]?.params ?? {},
              unstable_pattern: ft(m.matches),
            })
          ),
          m.fetchers.forEach((Z, q) => {
            Z.data !== void 0 && b.current.set(q, Z.data);
          }),
          B.forEach((Z) => b.current.delete(Z)),
          sr(
            G === !1 || t != null,
            'You provided the `flushSync` option to a router update, but you are not using the `<RouterProvider>` from `react-router/dom` so `ReactDOM.flushSync()` is unavailable.  Please update your app to `import { RouterProvider } from "react-router/dom"` and ensure you have `react-dom` installed as a dependency to use the `flushSync` option.'
          );
        let se =
          e.window != null &&
          e.window.document != null &&
          typeof e.window.document.startViewTransition == 'function';
        if (
          (sr(
            U == null || se,
            'You provided the `viewTransition` option to a router update, but you do not appear to be running in a DOM environment as `window.startViewTransition` is not available.'
          ),
          !U || !se)
        ) {
          t && G
            ? t(() => o(m))
            : n === !1
              ? o(m)
              : f.startTransition(() => {
                  n === !0 && s((Z) => wn(Z, m)), o(m);
                });
          return;
        }
        if (t && G) {
          t(() => {
            E && (y?.resolve(), E.skipTransition()),
              c({
                isTransitioning: !0,
                flushSync: !0,
                currentLocation: U.currentLocation,
                nextLocation: U.nextLocation,
              });
          });
          let Z = e.window.document.startViewTransition(() => {
            t(() => o(m));
          });
          Z.finished.finally(() => {
            t(() => {
              g(void 0), L(void 0), u(void 0), c({ isTransitioning: !1 });
            });
          }),
            t(() => L(Z));
          return;
        }
        E
          ? (y?.resolve(),
            E.skipTransition(),
            x({
              state: m,
              currentLocation: U.currentLocation,
              nextLocation: U.nextLocation,
            }))
          : (u(m),
            c({
              isTransitioning: !0,
              flushSync: !1,
              currentLocation: U.currentLocation,
              nextLocation: U.nextLocation,
            }));
      },
      [e.window, t, E, y, n, s, r]
    );
  f.useLayoutEffect(() => e.subscribe(T), [e, T]),
    f.useEffect(() => {
      h.isTransitioning && !h.flushSync && g(new vi());
    }, [h]),
    f.useEffect(() => {
      if (y && l && e.window) {
        let m = l,
          B = y.promise,
          W = e.window.document.startViewTransition(async () => {
            n === !1
              ? o(m)
              : f.startTransition(() => {
                  n === !0 && s((G) => wn(G, m)), o(m);
                }),
              await B;
          });
        W.finished.finally(() => {
          g(void 0), L(void 0), u(void 0), c({ isTransitioning: !1 });
        }),
          L(W);
      }
    }, [l, y, e.window, n, s]),
    f.useEffect(() => {
      y && l && i.location.key === l.location.key && y.resolve();
    }, [y, E, i.location, l]),
    f.useEffect(() => {
      !h.isTransitioning &&
        R &&
        (u(R.state),
        c({
          isTransitioning: !0,
          flushSync: !1,
          currentLocation: R.currentLocation,
          nextLocation: R.nextLocation,
        }),
        x(void 0));
    }, [h.isTransitioning, R]);
  let M = f.useMemo(
      () => ({
        createHref: e.createHref,
        encodeLocation: e.encodeLocation,
        go: (m) => e.navigate(m),
        push: (m, B, W) =>
          e.navigate(m, {
            state: B,
            preventScrollReset: W?.preventScrollReset,
          }),
        replace: (m, B, W) =>
          e.navigate(m, {
            replace: !0,
            state: B,
            preventScrollReset: W?.preventScrollReset,
          }),
      }),
      [e]
    ),
    D = e.basename || '/',
    k = f.useMemo(
      () => ({
        router: e,
        navigator: M,
        static: !1,
        basename: D,
        unstable_onError: r,
      }),
      [e, M, D, r]
    );
  return f.createElement(
    f.Fragment,
    null,
    f.createElement(
      Ve.Provider,
      { value: k },
      f.createElement(
        Qe.Provider,
        { value: i },
        f.createElement(
          zn.Provider,
          { value: b.current },
          f.createElement(
            wr.Provider,
            { value: h },
            f.createElement(
              Ei,
              {
                basename: D,
                location: i.location,
                navigationType: i.historyAction,
                navigator: M,
                unstable_useTransitions: n === !0,
              },
              f.createElement(gi, {
                routes: e.routes,
                future: e.future,
                state: i,
                unstable_onError: r,
              })
            )
          )
        )
      )
    ),
    null
  );
}
function wn(e, t) {
  return {
    ...e,
    navigation: t.navigation.state !== 'idle' ? t.navigation : e.navigation,
    revalidation: t.revalidation !== 'idle' ? t.revalidation : e.revalidation,
    actionData:
      t.navigation.state !== 'submitting' ? t.actionData : e.actionData,
    fetchers: t.fetchers,
  };
}
var gi = f.memo(wi);
function wi({ routes: e, future: t, state: r, unstable_onError: n }) {
  return ni(e, void 0, r, n, t);
}
function rs(e) {
  return ri(e.context);
}
function Ei({
  basename: e = '/',
  children: t = null,
  location: r,
  navigationType: n = 'POP',
  navigator: a,
  static: o = !1,
  unstable_useTransitions: i,
}) {
  V(
    !ht(),
    'You cannot render a <Router> inside another <Router>. You should never have more than one in your app.'
  );
  let s = e.replace(/^\/*/, '/'),
    l = f.useMemo(
      () => ({
        basename: s,
        navigator: a,
        static: o,
        unstable_useTransitions: i,
        future: {},
      }),
      [s, a, o, i]
    );
  typeof r == 'string' && (r = $e(r));
  let {
      pathname: u = '/',
      search: h = '',
      hash: c = '',
      state: y = null,
      key: g = 'default',
    } = r,
    E = f.useMemo(() => {
      let L = Ee(u, s);
      return L == null
        ? null
        : {
            location: { pathname: L, search: h, hash: c, state: y, key: g },
            navigationType: n,
          };
    }, [s, u, h, c, y, g, n]);
  return (
    ie(
      E != null,
      `<Router basename="${s}"> is not able to match the URL "${u}${h}${c}" because it does not start with the basename, so the <Router> won't render anything.`
    ),
    E == null
      ? null
      : f.createElement(
          Re.Provider,
          { value: l },
          f.createElement(Ft.Provider, { children: t, value: E })
        )
  );
}
function Ri() {
  return { params: Yn(), loaderData: Vn(), actionData: Jn(), matches: br() };
}
function ns(e) {
  return function () {
    const r = Ri();
    return f.createElement(e, r);
  };
}
function bi() {
  return { params: Yn(), loaderData: Vn(), actionData: Jn(), error: Sr() };
}
function as(e) {
  return function () {
    const r = bi();
    return f.createElement(e, r);
  };
}
var Dt = 'get',
  _t = 'application/x-www-form-urlencoded';
function jt(e) {
  return typeof HTMLElement < 'u' && e instanceof HTMLElement;
}
function Si(e) {
  return jt(e) && e.tagName.toLowerCase() === 'button';
}
function xi(e) {
  return jt(e) && e.tagName.toLowerCase() === 'form';
}
function Ci(e) {
  return jt(e) && e.tagName.toLowerCase() === 'input';
}
function Li(e) {
  return !!(e.metaKey || e.altKey || e.ctrlKey || e.shiftKey);
}
function Pi(e, t) {
  return e.button === 0 && (!t || t === '_self') && !Li(e);
}
var Ct = null;
function Mi() {
  if (Ct === null)
    try {
      new FormData(document.createElement('form'), 0), (Ct = !1);
    } catch {
      Ct = !0;
    }
  return Ct;
}
var Ti = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]);
function Zt(e) {
  return e != null && !Ti.has(e)
    ? (ie(
        !1,
        `"${e}" is not a valid \`encType\` for \`<Form>\`/\`<fetcher.Form>\` and will default to "${_t}"`
      ),
      null)
    : e;
}
function Di(e, t) {
  let r, n, a, o, i;
  if (xi(e)) {
    let s = e.getAttribute('action');
    (n = s ? Ee(s, t) : null),
      (r = e.getAttribute('method') || Dt),
      (a = Zt(e.getAttribute('enctype')) || _t),
      (o = new FormData(e));
  } else if (Si(e) || (Ci(e) && (e.type === 'submit' || e.type === 'image'))) {
    let s = e.form;
    if (s == null)
      throw new Error(
        'Cannot submit a <button> or <input type="submit"> without a <form>'
      );
    let l = e.getAttribute('formaction') || s.getAttribute('action');
    if (
      ((n = l ? Ee(l, t) : null),
      (r = e.getAttribute('formmethod') || s.getAttribute('method') || Dt),
      (a =
        Zt(e.getAttribute('formenctype')) ||
        Zt(s.getAttribute('enctype')) ||
        _t),
      (o = new FormData(s, e)),
      !Mi())
    ) {
      let { name: u, type: h, value: c } = e;
      if (h === 'image') {
        let y = u ? `${u}.` : '';
        o.append(`${y}x`, '0'), o.append(`${y}y`, '0');
      } else u && o.append(u, c);
    }
  } else {
    if (jt(e))
      throw new Error(
        'Cannot submit element that is not <form>, <button>, or <input type="submit|image">'
      );
    (r = Dt), (n = null), (a = _t), (i = e);
  }
  return (
    o && a === 'text/plain' && ((i = o), (o = void 0)),
    { action: n, method: r.toLowerCase(), encType: a, formData: o, body: i }
  );
}
var _i = -1,
  Oi = -2,
  Ai = -3,
  Ni = -4,
  ki = -5,
  Ii = -6,
  $i = -7,
  Fi = 'B',
  ji = 'D',
  Xn = 'E',
  Hi = 'M',
  Ui = 'N',
  Kn = 'P',
  zi = 'R',
  Bi = 'S',
  Wi = 'Y',
  Yi = 'U',
  Vi = 'Z',
  qn = class {
    constructor() {
      this.promise = new Promise((e, t) => {
        (this.resolve = e), (this.reject = t);
      });
    }
  };
function Ji() {
  const e = new TextDecoder();
  let t = '';
  return new TransformStream({
    transform(r, n) {
      const a = e.decode(r, { stream: !0 }),
        o = (t + a).split(`
`);
      t = o.pop() || '';
      for (const i of o) n.enqueue(i);
    },
    flush(r) {
      t && r.enqueue(t);
    },
  });
}
Object.getOwnPropertyNames(Object.prototype).sort().join('\0');
var er =
  typeof window < 'u' ? window : typeof globalThis < 'u' ? globalThis : void 0;
function ur(e) {
  const { hydrated: t, values: r } = this;
  if (typeof e == 'number') return En.call(this, e);
  if (!Array.isArray(e) || !e.length) throw new SyntaxError();
  const n = r.length;
  for (const a of e) r.push(a);
  return (t.length = r.length), En.call(this, n);
}
function En(e) {
  const { hydrated: t, values: r, deferred: n, plugins: a } = this;
  let o;
  const i = [
    [
      e,
      (l) => {
        o = l;
      },
    ],
  ];
  let s = [];
  for (; i.length > 0; ) {
    const [l, u] = i.pop();
    switch (l) {
      case $i:
        u(void 0);
        continue;
      case ki:
        u(null);
        continue;
      case Oi:
        u(NaN);
        continue;
      case Ii:
        u(1 / 0);
        continue;
      case Ai:
        u(-1 / 0);
        continue;
      case Ni:
        u(-0);
        continue;
    }
    if (t[l]) {
      u(t[l]);
      continue;
    }
    const h = r[l];
    if (!h || typeof h != 'object') {
      (t[l] = h), u(h);
      continue;
    }
    if (Array.isArray(h))
      if (typeof h[0] == 'string') {
        const [c, y, g] = h;
        switch (c) {
          case ji:
            u((t[l] = new Date(y)));
            continue;
          case Yi:
            u((t[l] = new URL(y)));
            continue;
          case Fi:
            u((t[l] = BigInt(y)));
            continue;
          case zi:
            u((t[l] = new RegExp(y, g)));
            continue;
          case Wi:
            u((t[l] = Symbol.for(y)));
            continue;
          case Bi:
            const E = new Set();
            t[l] = E;
            for (let M = h.length - 1; M > 0; M--)
              i.push([
                h[M],
                (D) => {
                  E.add(D);
                },
              ]);
            u(E);
            continue;
          case Hi:
            const L = new Map();
            t[l] = L;
            for (let M = h.length - 2; M > 0; M -= 2) {
              const D = [];
              i.push([
                h[M + 1],
                (k) => {
                  D[1] = k;
                },
              ]),
                i.push([
                  h[M],
                  (k) => {
                    D[0] = k;
                  },
                ]),
                s.push(() => {
                  L.set(D[0], D[1]);
                });
            }
            u(L);
            continue;
          case Ui:
            const R = Object.create(null);
            t[l] = R;
            for (const M of Object.keys(y).reverse()) {
              const D = [];
              i.push([
                y[M],
                (k) => {
                  D[1] = k;
                },
              ]),
                i.push([
                  Number(M.slice(1)),
                  (k) => {
                    D[0] = k;
                  },
                ]),
                s.push(() => {
                  R[D[0]] = D[1];
                });
            }
            u(R);
            continue;
          case Kn:
            if (t[y]) u((t[l] = t[y]));
            else {
              const M = new qn();
              (n[y] = M), u((t[l] = M.promise));
            }
            continue;
          case Xn:
            const [, x, b] = h;
            let T = b && er && er[b] ? new er[b](x) : new Error(x);
            (t[l] = T), u(T);
            continue;
          case Vi:
            u((t[l] = t[y]));
            continue;
          default:
            if (Array.isArray(a)) {
              const M = [],
                D = h.slice(1);
              for (let k = 0; k < D.length; k++) {
                const m = D[k];
                i.push([
                  m,
                  (B) => {
                    M[k] = B;
                  },
                ]);
              }
              s.push(() => {
                for (const k of a) {
                  const m = k(h[0], ...M);
                  if (m) {
                    u((t[l] = m.value));
                    return;
                  }
                }
                throw new SyntaxError();
              });
              continue;
            }
            throw new SyntaxError();
        }
      } else {
        const c = [];
        t[l] = c;
        for (let y = 0; y < h.length; y++) {
          const g = h[y];
          g !== _i &&
            i.push([
              g,
              (E) => {
                c[y] = E;
              },
            ]);
        }
        u(c);
        continue;
      }
    else {
      const c = {};
      t[l] = c;
      for (const y of Object.keys(h).reverse()) {
        const g = [];
        i.push([
          h[y],
          (E) => {
            g[1] = E;
          },
        ]),
          i.push([
            Number(y.slice(1)),
            (E) => {
              g[0] = E;
            },
          ]),
          s.push(() => {
            c[g[0]] = g[1];
          });
      }
      u(c);
      continue;
    }
  }
  for (; s.length > 0; ) s.pop()();
  return o;
}
async function Gi(e, t) {
  const { plugins: r } = t ?? {},
    n = new qn(),
    a = e.pipeThrough(Ji()).getReader(),
    o = { values: [], hydrated: [], deferred: {}, plugins: r },
    i = await Xi.call(o, a);
  let s = n.promise;
  return (
    i.done
      ? n.resolve()
      : (s = Ki.call(o, a)
          .then(n.resolve)
          .catch((l) => {
            for (const u of Object.values(o.deferred)) u.reject(l);
            n.reject(l);
          })),
    { done: s.then(() => a.closed), value: i.value }
  );
}
async function Xi(e) {
  const t = await e.read();
  if (!t.value) throw new SyntaxError();
  let r;
  try {
    r = JSON.parse(t.value);
  } catch {
    throw new SyntaxError();
  }
  return { done: t.done, value: ur.call(this, r) };
}
async function Ki(e) {
  let t = await e.read();
  for (; !t.done; ) {
    if (!t.value) continue;
    const r = t.value;
    switch (r[0]) {
      case Kn: {
        const n = r.indexOf(':'),
          a = Number(r.slice(1, n)),
          o = this.deferred[a];
        if (!o) throw new Error(`Deferred ID ${a} not found in stream`);
        const i = r.slice(n + 1);
        let s;
        try {
          s = JSON.parse(i);
        } catch {
          throw new SyntaxError();
        }
        const l = ur.call(this, s);
        o.resolve(l);
        break;
      }
      case Xn: {
        const n = r.indexOf(':'),
          a = Number(r.slice(1, n)),
          o = this.deferred[a];
        if (!o) throw new Error(`Deferred ID ${a} not found in stream`);
        const i = r.slice(n + 1);
        let s;
        try {
          s = JSON.parse(i);
        } catch {
          throw new SyntaxError();
        }
        const l = ur.call(this, s);
        o.reject(l);
        break;
      }
      default:
        throw new SyntaxError();
    }
    t = await e.read();
  }
}
async function qi(e) {
  let t = { signal: e.signal };
  if (e.method !== 'GET') {
    t.method = e.method;
    let r = e.headers.get('Content-Type');
    r && /\bapplication\/json\b/.test(r)
      ? ((t.headers = { 'Content-Type': r }),
        (t.body = JSON.stringify(await e.json())))
      : r && /\btext\/plain\b/.test(r)
        ? ((t.headers = { 'Content-Type': r }), (t.body = await e.text()))
        : r && /\bapplication\/x-www-form-urlencoded\b/.test(r)
          ? (t.body = new URLSearchParams(await e.text()))
          : (t.body = await e.formData());
  }
  return t;
}
var Qi = {
    '&': '\\u0026',
    '>': '\\u003e',
    '<': '\\u003c',
    '\u2028': '\\u2028',
    '\u2029': '\\u2029',
  },
  Zi = /[&><\u2028\u2029]/g;
function el(e) {
  return e.replace(Zi, (t) => Qi[t]);
}
function ge(e, t) {
  if (e === !1 || e === null || typeof e > 'u') throw new Error(t);
}
var cr = Symbol('SingleFetchRedirect'),
  Qn = class extends Error {},
  tl = 202,
  rl = new Set([100, 101, 204, 205]);
function os(e, t, r, n, a) {
  let o = nl(
    e,
    (i) => {
      let s = t.routes[i.route.id];
      ge(s, 'Route not found in manifest');
      let l = r[i.route.id];
      return {
        hasLoader: s.hasLoader,
        hasClientLoader: s.hasClientLoader,
        hasShouldRevalidate: !!l?.shouldRevalidate,
      };
    },
    cl,
    n,
    a
  );
  return async (i) => i.runClientMiddleware(o);
}
function nl(e, t, r, n, a, o = () => !0) {
  return async (i) => {
    let { request: s, matches: l, fetcherKey: u } = i,
      h = e();
    if (s.method !== 'GET') return al(i, r, a);
    let c = l.some((y) => {
      let { hasLoader: g, hasClientLoader: E } = t(y);
      return y.shouldCallHandler() && g && !E;
    });
    return !n && !c
      ? ol(i, t, r, a)
      : u
        ? sl(i, r, a)
        : il(i, h, t, r, n, a, o);
  };
}
async function al(e, t, r) {
  let n = e.matches.find((i) => i.shouldCallHandler());
  ge(n, 'No action match found');
  let a,
    o = await n.resolve(
      async (i) =>
        await i(async () => {
          let { data: l, status: u } = await t(e, r, [n.route.id]);
          return (a = u), dt(l, n.route.id);
        })
    );
  return vr(o.result) || We(o.result) || lr(o.result)
    ? { [n.route.id]: o }
    : { [n.route.id]: { type: o.type, result: fo(o.result, a) } };
}
async function ol(e, t, r, n) {
  let a = e.matches.filter((i) => i.shouldCallHandler()),
    o = {};
  return (
    await Promise.all(
      a.map((i) =>
        i.resolve(async (s) => {
          try {
            let { hasClientLoader: l } = t(i),
              u = i.route.id,
              h = l
                ? await s(async () => {
                    let { data: c } = await r(e, n, [u]);
                    return dt(c, u);
                  })
                : await s();
            o[i.route.id] = { type: 'data', result: h };
          } catch (l) {
            o[i.route.id] = { type: 'error', result: l };
          }
        })
      )
    ),
    o
  );
}
async function il(e, t, r, n, a, o, i = () => !0) {
  let s = new Set(),
    l = !1,
    u = e.matches.map(() => Rn()),
    h = Rn(),
    c = {},
    y = Promise.all(
      e.matches.map(async (E, L) =>
        E.resolve(async (R) => {
          u[L].resolve();
          let x = E.route.id,
            { hasLoader: b, hasClientLoader: T, hasShouldRevalidate: M } = r(E),
            D =
              !E.shouldRevalidateArgs ||
              E.shouldRevalidateArgs.actionStatus == null ||
              E.shouldRevalidateArgs.actionStatus < 400;
          if (!E.shouldCallHandler(D)) {
            l || (l = E.shouldRevalidateArgs != null && b && M === !0);
            return;
          }
          if (i(E) && T) {
            b && (l = !0);
            try {
              let m = await R(async () => {
                let { data: B } = await n(e, o, [x]);
                return dt(B, x);
              });
              c[x] = { type: 'data', result: m };
            } catch (m) {
              c[x] = { type: 'error', result: m };
            }
            return;
          }
          b && s.add(x);
          try {
            let m = await R(async () => {
              let B = await h.promise;
              return dt(B, x);
            });
            c[x] = { type: 'data', result: m };
          } catch (m) {
            c[x] = { type: 'error', result: m };
          }
        })
      )
    );
  if (
    (await Promise.all(u.map((E) => E.promise)),
    ((!t.state.initialized && t.state.navigation.state === 'idle') ||
      s.size === 0) &&
      !window.__reactRouterHdrActive)
  )
    h.resolve({ routes: {} });
  else {
    let E = a && l && s.size > 0 ? [...s.keys()] : void 0;
    try {
      let L = await n(e, o, E);
      h.resolve(L.data);
    } catch (L) {
      h.reject(L);
    }
  }
  return await y, await ll(h.promise, e.matches, s, c), c;
}
async function ll(e, t, r, n) {
  try {
    let a,
      o = await e;
    if ('routes' in o) {
      for (let i of t)
        if (i.route.id in o.routes) {
          let s = o.routes[i.route.id];
          if ('error' in s) {
            (a = s.error),
              n[i.route.id]?.result == null &&
                (n[i.route.id] = { type: 'error', result: a });
            break;
          }
        }
    }
    a !== void 0 &&
      Array.from(r.values()).forEach((i) => {
        n[i].result instanceof Qn && (n[i].result = a);
      });
  } catch {}
}
async function sl(e, t, r) {
  let n = e.matches.find((i) => i.shouldCallHandler());
  ge(n, 'No fetcher match found');
  let a = n.route.id,
    o = await n.resolve(async (i) =>
      i(async () => {
        let { data: s } = await t(e, r, [a]);
        return dt(s, a);
      })
    );
  return { [n.route.id]: o };
}
function ul(e) {
  let t = e.searchParams.getAll('index');
  e.searchParams.delete('index');
  let r = [];
  for (let n of t) n && r.push(n);
  for (let n of r) e.searchParams.append('index', n);
  return e;
}
function Zn(e, t, r) {
  let n =
    typeof e == 'string'
      ? new URL(
          e,
          typeof window > 'u' ? 'server://singlefetch/' : window.location.origin
        )
      : e;
  return (
    n.pathname === '/'
      ? (n.pathname = `_root.${r}`)
      : t && Ee(n.pathname, t) === '/'
        ? (n.pathname = `${t.replace(/\/$/, '')}/_root.${r}`)
        : (n.pathname = `${n.pathname.replace(/\/$/, '')}.${r}`),
    n
  );
}
async function cl(e, t, r) {
  let { request: n } = e,
    a = Zn(n.url, t, 'data');
  n.method === 'GET' &&
    ((a = ul(a)), r && a.searchParams.set('_routes', r.join(',')));
  let o = await fetch(a, await qi(n));
  if (o.status >= 400 && !o.headers.has('X-Remix-Response'))
    throw new Ye(o.status, o.statusText, await o.text());
  if (o.status === 204 && o.headers.has('X-Remix-Redirect'))
    return {
      status: tl,
      data: {
        redirect: {
          redirect: o.headers.get('X-Remix-Redirect'),
          status: Number(o.headers.get('X-Remix-Status') || '302'),
          revalidate: o.headers.get('X-Remix-Revalidate') === 'true',
          reload: o.headers.get('X-Remix-Reload-Document') === 'true',
          replace: o.headers.get('X-Remix-Replace') === 'true',
        },
      },
    };
  if (rl.has(o.status)) {
    let i = {};
    return (
      r && n.method !== 'GET' && (i[r[0]] = { data: void 0 }),
      { status: o.status, data: { routes: i } }
    );
  }
  ge(o.body, 'No response body to decode');
  try {
    let i = await dl(o.body, window),
      s;
    if (n.method === 'GET') {
      let l = i.value;
      cr in l ? (s = { redirect: l[cr] }) : (s = { routes: l });
    } else {
      let l = i.value,
        u = r?.[0];
      ge(u, 'No routeId found for single fetch call decoding'),
        'redirect' in l ? (s = { redirect: l }) : (s = { routes: { [u]: l } });
    }
    return { status: o.status, data: s };
  } catch {
    throw new Error('Unable to decode turbo-stream response');
  }
}
function dl(e, t) {
  return Gi(e, {
    plugins: [
      (r, ...n) => {
        if (r === 'SanitizedError') {
          let [a, o, i] = n,
            s = Error;
          a && a in t && typeof t[a] == 'function' && (s = t[a]);
          let l = new s(o);
          return (l.stack = i), { value: l };
        }
        if (r === 'ErrorResponse') {
          let [a, o, i] = n;
          return { value: new Ye(o, i, a) };
        }
        if (r === 'SingleFetchRedirect') return { value: { [cr]: n[0] } };
        if (r === 'SingleFetchClassInstance') return { value: n[0] };
        if (r === 'SingleFetchFallback') return { value: void 0 };
      },
    ],
  });
}
function dt(e, t) {
  if ('redirect' in e) {
    let {
      redirect: n,
      revalidate: a,
      reload: o,
      replace: i,
      status: s,
    } = e.redirect;
    throw ho(n, {
      status: s,
      headers: {
        ...(a ? { 'X-Remix-Revalidate': 'yes' } : null),
        ...(o ? { 'X-Remix-Reload-Document': 'yes' } : null),
        ...(i ? { 'X-Remix-Replace': 'yes' } : null),
      },
    });
  }
  let r = e.routes[t];
  if (r == null) throw new Qn(`No result found for routeId "${t}"`);
  if ('error' in r) throw r.error;
  if ('data' in r) return r.data;
  throw new Error(`Invalid response found for routeId "${t}"`);
}
function Rn() {
  let e,
    t,
    r = new Promise((n, a) => {
      (e = async (o) => {
        n(o);
        try {
          await r;
        } catch {}
      }),
        (t = async (o) => {
          a(o);
          try {
            await r;
          } catch {}
        });
    });
  return { promise: r, resolve: e, reject: t };
}
async function ea(e, t) {
  if (e.id in t) return t[e.id];
  try {
    let r = await import(e.module);
    return (t[e.id] = r), r;
  } catch (r) {
    return (
      console.error(
        `Error loading route module \`${e.module}\`, reloading page...`
      ),
      console.error(r),
      window.__reactRouterContext && window.__reactRouterContext.isSpaMode,
      window.location.reload(),
      new Promise(() => {})
    );
  }
}
function fl(e, t, r) {
  let n = e
      .map((o) => {
        let i = t[o.route.id],
          s = r.routes[o.route.id];
        return [
          s && s.css ? s.css.map((l) => ({ rel: 'stylesheet', href: l })) : [],
          i?.links?.() || [],
        ];
      })
      .flat(2),
    a = Cr(e, r);
  return aa(n, a);
}
function ta(e) {
  return e.css ? e.css.map((t) => ({ rel: 'stylesheet', href: t })) : [];
}
async function hl(e) {
  if (!e.css) return;
  let t = ta(e);
  await Promise.all(t.map(na));
}
async function ra(e, t) {
  if ((!e.css && !t.links) || !gl()) return;
  let r = [];
  if (
    (e.css && r.push(...ta(e)), t.links && r.push(...t.links()), r.length === 0)
  )
    return;
  let n = [];
  for (let a of r)
    !xr(a) &&
      a.rel === 'stylesheet' &&
      n.push({ ...a, rel: 'preload', as: 'style' });
  await Promise.all(n.map(na));
}
async function na(e) {
  return new Promise((t) => {
    if (
      (e.media && !window.matchMedia(e.media).matches) ||
      document.querySelector(`link[rel="stylesheet"][href="${e.href}"]`)
    )
      return t();
    let r = document.createElement('link');
    Object.assign(r, e);
    function n() {
      document.head.contains(r) && document.head.removeChild(r);
    }
    (r.onload = () => {
      n(), t();
    }),
      (r.onerror = () => {
        n(), t();
      }),
      document.head.appendChild(r);
  });
}
function xr(e) {
  return e != null && typeof e.page == 'string';
}
function ml(e) {
  return e == null
    ? !1
    : e.href == null
      ? e.rel === 'preload' &&
        typeof e.imageSrcSet == 'string' &&
        typeof e.imageSizes == 'string'
      : typeof e.rel == 'string' && typeof e.href == 'string';
}
async function pl(e, t, r) {
  let n = await Promise.all(
    e.map(async (a) => {
      let o = t.routes[a.route.id];
      if (o) {
        let i = await ea(o, r);
        return i.links ? i.links() : [];
      }
      return [];
    })
  );
  return aa(
    n
      .flat(1)
      .filter(ml)
      .filter((a) => a.rel === 'stylesheet' || a.rel === 'preload')
      .map((a) =>
        a.rel === 'stylesheet'
          ? { ...a, rel: 'prefetch', as: 'style' }
          : { ...a, rel: 'prefetch' }
      )
  );
}
function bn(e, t, r, n, a, o) {
  let i = (l, u) => (r[u] ? l.route.id !== r[u].route.id : !0),
    s = (l, u) =>
      r[u].pathname !== l.pathname ||
      (r[u].route.path?.endsWith('*') && r[u].params['*'] !== l.params['*']);
  return o === 'assets'
    ? t.filter((l, u) => i(l, u) || s(l, u))
    : o === 'data'
      ? t.filter((l, u) => {
          let h = n.routes[l.route.id];
          if (!h || !h.hasLoader) return !1;
          if (i(l, u) || s(l, u)) return !0;
          if (l.route.shouldRevalidate) {
            let c = l.route.shouldRevalidate({
              currentUrl: new URL(
                a.pathname + a.search + a.hash,
                window.origin
              ),
              currentParams: r[0]?.params || {},
              nextUrl: new URL(e, window.origin),
              nextParams: l.params,
              defaultShouldRevalidate: !0,
            });
            if (typeof c == 'boolean') return c;
          }
          return !0;
        })
      : [];
}
function Cr(e, t, { includeHydrateFallback: r } = {}) {
  return yl(
    e
      .map((n) => {
        let a = t.routes[n.route.id];
        if (!a) return [];
        let o = [a.module];
        return (
          a.clientActionModule && (o = o.concat(a.clientActionModule)),
          a.clientLoaderModule && (o = o.concat(a.clientLoaderModule)),
          r &&
            a.hydrateFallbackModule &&
            (o = o.concat(a.hydrateFallbackModule)),
          a.imports && (o = o.concat(a.imports)),
          o
        );
      })
      .flat(1)
  );
}
function yl(e) {
  return [...new Set(e)];
}
function vl(e) {
  let t = {},
    r = Object.keys(e).sort();
  for (let n of r) t[n] = e[n];
  return t;
}
function aa(e, t) {
  let r = new Set(),
    n = new Set(t);
  return e.reduce((a, o) => {
    if (t && !xr(o) && o.as === 'script' && o.href && n.has(o.href)) return a;
    let s = JSON.stringify(vl(o));
    return r.has(s) || (r.add(s), a.push({ key: s, link: o })), a;
  }, []);
}
var Lt;
function gl() {
  if (Lt !== void 0) return Lt;
  let e = document.createElement('link');
  return (Lt = e.relList.supports('preload')), (e = null), Lt;
}
function wl() {
  return f.createElement(
    dr,
    { title: 'Loading...', renderScripts: !0 },
    f.createElement('script', {
      dangerouslySetInnerHTML: {
        __html: `
              console.log(
                "💿 Hey developer 👋. You can provide a way better UX than this " +
                "when your app is loading JS modules and/or running \`clientLoader\` " +
                "functions. Check out https://reactrouter.com/start/framework/route-module#hydratefallback " +
                "for more information."
              );
            `,
      },
    })
  );
}
function oa(e) {
  let t = {};
  return (
    Object.values(e).forEach((r) => {
      if (r) {
        let n = r.parentId || '';
        t[n] || (t[n] = []), t[n].push(r);
      }
    }),
    t
  );
}
function El(e, t, r) {
  let n = ia(t),
    a =
      t.HydrateFallback && (!r || e.id === 'root')
        ? t.HydrateFallback
        : e.id === 'root'
          ? wl
          : void 0,
    o = t.ErrorBoundary
      ? t.ErrorBoundary
      : e.id === 'root'
        ? () => f.createElement(ua, { error: Sr() })
        : void 0;
  return e.id === 'root' && t.Layout
    ? {
        ...(n
          ? {
              element: f.createElement(
                t.Layout,
                null,
                f.createElement(n, null)
              ),
            }
          : { Component: n }),
        ...(o
          ? {
              errorElement: f.createElement(
                t.Layout,
                null,
                f.createElement(o, null)
              ),
            }
          : { ErrorBoundary: o }),
        ...(a
          ? {
              hydrateFallbackElement: f.createElement(
                t.Layout,
                null,
                f.createElement(a, null)
              ),
            }
          : { HydrateFallback: a }),
      }
    : { Component: n, ErrorBoundary: o, HydrateFallback: a };
}
function is(e, t, r, n, a, o) {
  return Lr(t, r, n, a, o, '', oa(t), e);
}
function Pt(e, t) {
  if ((e === 'loader' && !t.hasLoader) || (e === 'action' && !t.hasAction)) {
    let n = `You are trying to call ${e === 'action' ? 'serverAction()' : 'serverLoader()'} on a route that does not have a server ${e} (routeId: "${t.id}")`;
    throw (console.error(n), new Ye(400, 'Bad Request', new Error(n), !0));
  }
}
function tr(e, t) {
  let r = e === 'clientAction' ? 'a' : 'an',
    n = `Route "${t}" does not have ${r} ${e}, but you are trying to submit to it. To fix this, please add ${r} \`${e}\` function to the route`;
  throw (console.error(n), new Ye(405, 'Method Not Allowed', new Error(n), !0));
}
function Lr(e, t, r, n, a, o = '', i = oa(e), s) {
  return (i[o] || []).map((l) => {
    let u = t[l.id];
    function h(b) {
      return (
        ge(
          typeof b == 'function',
          'No single fetch function available for route handler'
        ),
        b()
      );
    }
    function c(b) {
      return l.hasLoader ? h(b) : Promise.resolve(null);
    }
    function y(b) {
      if (!l.hasAction) throw tr('action', l.id);
      return h(b);
    }
    function g(b) {
      import(b);
    }
    function E(b) {
      b.clientActionModule && g(b.clientActionModule),
        b.clientLoaderModule && g(b.clientLoaderModule);
    }
    async function L(b) {
      let T = t[l.id],
        M = T ? ra(l, T) : Promise.resolve();
      try {
        return b();
      } finally {
        await M;
      }
    }
    let R = { id: l.id, index: l.index, path: l.path };
    if (u) {
      Object.assign(R, {
        ...R,
        ...El(l, u, a),
        middleware: u.clientMiddleware,
        handle: u.handle,
        shouldRevalidate: Sn(R.path, u, l, n, s),
      });
      let b = r && r.loaderData && l.id in r.loaderData,
        T = b ? r?.loaderData?.[l.id] : void 0,
        M = r && r.errors && l.id in r.errors,
        D = M ? r?.errors?.[l.id] : void 0,
        k = s == null && (u.clientLoader?.hydrate === !0 || !l.hasLoader);
      (R.loader = async (
        { request: m, params: B, context: W, unstable_pattern: G },
        U
      ) => {
        try {
          return await L(
            async () => (
              ge(u, 'No `routeModule` available for critical-route loader'),
              u.clientLoader
                ? u.clientLoader({
                    request: m,
                    params: B,
                    context: W,
                    unstable_pattern: G,
                    async serverLoader() {
                      if ((Pt('loader', l), k)) {
                        if (b) return T;
                        if (M) throw D;
                      }
                      return c(U);
                    },
                  })
                : c(U)
            )
          );
        } finally {
          k = !1;
        }
      }),
        (R.loader.hydrate = Sl(l.id, u.clientLoader, l.hasLoader, a)),
        (R.action = (
          { request: m, params: B, context: W, unstable_pattern: G },
          U
        ) =>
          L(async () => {
            if (
              (ge(u, 'No `routeModule` available for critical-route action'),
              !u.clientAction)
            ) {
              if (a) throw tr('clientAction', l.id);
              return y(U);
            }
            return u.clientAction({
              request: m,
              params: B,
              context: W,
              unstable_pattern: G,
              async serverAction() {
                return Pt('action', l), y(U);
              },
            });
          }));
    } else {
      l.hasClientLoader || (R.loader = (M, D) => L(() => c(D))),
        l.hasClientAction ||
          (R.action = (M, D) =>
            L(() => {
              if (a) throw tr('clientAction', l.id);
              return y(D);
            }));
      let b;
      async function T() {
        return b
          ? await b
          : ((b = (async () => {
              (l.clientLoaderModule || l.clientActionModule) &&
                (await new Promise((D) => setTimeout(D, 0)));
              let M = bl(l, t);
              return E(l), await M;
            })()),
            await b);
      }
      R.lazy = {
        loader: l.hasClientLoader
          ? async () => {
              let { clientLoader: M } = l.clientLoaderModule
                ? await import(l.clientLoaderModule)
                : await T();
              return (
                ge(M, 'No `clientLoader` export found'),
                (D, k) =>
                  M({
                    ...D,
                    async serverLoader() {
                      return Pt('loader', l), c(k);
                    },
                  })
              );
            }
          : void 0,
        action: l.hasClientAction
          ? async () => {
              let M = l.clientActionModule ? import(l.clientActionModule) : T();
              E(l);
              let { clientAction: D } = await M;
              return (
                ge(D, 'No `clientAction` export found'),
                (k, m) =>
                  D({
                    ...k,
                    async serverAction() {
                      return Pt('action', l), y(m);
                    },
                  })
              );
            }
          : void 0,
        middleware: l.hasClientMiddleware
          ? async () => {
              let { clientMiddleware: M } = l.clientMiddlewareModule
                ? await import(l.clientMiddlewareModule)
                : await T();
              return ge(M, 'No `clientMiddleware` export found'), M;
            }
          : void 0,
        shouldRevalidate: async () => {
          let M = await T();
          return Sn(R.path, M, l, n, s);
        },
        handle: async () => (await T()).handle,
        Component: async () => (await T()).Component,
        ErrorBoundary: l.hasErrorBoundary
          ? async () => (await T()).ErrorBoundary
          : void 0,
      };
    }
    let x = Lr(e, t, r, n, a, l.id, i, s);
    return x.length > 0 && (R.children = x), R;
  });
}
function Sn(e, t, r, n, a) {
  if (a) return Rl(r.id, t.shouldRevalidate, a);
  if (!n && r.hasLoader && !r.hasClientLoader) {
    let o = e ? Dn(e)[1].map((s) => s.paramName) : [];
    const i = (s) => o.some((l) => s.currentParams[l] !== s.nextParams[l]);
    if (t.shouldRevalidate) {
      let s = t.shouldRevalidate;
      return (l) => s({ ...l, defaultShouldRevalidate: i(l) });
    } else return (s) => i(s);
  }
  return t.shouldRevalidate;
}
function Rl(e, t, r) {
  let n = !1;
  return (a) =>
    n ? (t ? t(a) : a.defaultShouldRevalidate) : ((n = !0), r.has(e));
}
async function bl(e, t) {
  let r = ea(e, t),
    n = hl(e),
    a = await r;
  return (
    await Promise.all([n, ra(e, a)]),
    {
      Component: ia(a),
      ErrorBoundary: a.ErrorBoundary,
      clientMiddleware: a.clientMiddleware,
      clientAction: a.clientAction,
      clientLoader: a.clientLoader,
      handle: a.handle,
      links: a.links,
      meta: a.meta,
      shouldRevalidate: a.shouldRevalidate,
    }
  );
}
function ia(e) {
  if (e.default == null) return;
  if (!(typeof e.default == 'object' && Object.keys(e.default).length === 0))
    return e.default;
}
function Sl(e, t, r, n) {
  return (n && e !== 'root') || (t != null && (t.hydrate === !0 || r !== !0));
}
var Ot = new Set(),
  xl = 1e3,
  kt = new Set(),
  Cl = 7680;
function Pr(e, t) {
  return e.mode === 'lazy' && t === !0;
}
function Ll({ sri: e, ...t }, r) {
  let n = new Set(r.state.matches.map((s) => s.route.id)),
    a = r.state.location.pathname.split('/').filter(Boolean),
    o = ['/'];
  for (a.pop(); a.length > 0; ) o.push(`/${a.join('/')}`), a.pop();
  o.forEach((s) => {
    let l = Ae(r.routes, s, r.basename);
    l && l.forEach((u) => n.add(u.route.id));
  });
  let i = [...n].reduce((s, l) => Object.assign(s, { [l]: t.routes[l] }), {});
  return { ...t, routes: i, sri: e ? !0 : void 0 };
}
function ls(e, t, r, n, a, o) {
  if (Pr(n, r))
    return async ({ path: i, patch: s, signal: l, fetcherKey: u }) => {
      kt.has(i) ||
        (await la(
          [i],
          u ? window.location.href : i,
          e,
          t,
          r,
          a,
          o,
          n.manifestPath,
          s,
          l
        ));
    };
}
function ss(e, t, r, n, a, o) {
  f.useEffect(() => {
    if (!Pr(a, n) || window.navigator?.connection?.saveData === !0) return;
    function i(h) {
      let c =
        h.tagName === 'FORM'
          ? h.getAttribute('action')
          : h.getAttribute('href');
      if (!c) return;
      let y =
        h.tagName === 'A'
          ? h.pathname
          : new URL(c, window.location.origin).pathname;
      kt.has(y) || Ot.add(y);
    }
    async function s() {
      document
        .querySelectorAll('a[data-discover], form[data-discover]')
        .forEach(i);
      let h = Array.from(Ot.keys()).filter((c) =>
        kt.has(c) ? (Ot.delete(c), !1) : !0
      );
      if (h.length !== 0)
        try {
          await la(
            h,
            null,
            t,
            r,
            n,
            o,
            e.basename,
            a.manifestPath,
            e.patchRoutes
          );
        } catch (c) {
          console.error('Failed to fetch manifest patches', c);
        }
    }
    let l = Tl(s, 100);
    s();
    let u = new MutationObserver(() => l());
    return (
      u.observe(document.documentElement, {
        subtree: !0,
        childList: !0,
        attributes: !0,
        attributeFilter: ['data-discover', 'href', 'action'],
      }),
      () => u.disconnect()
    );
  }, [n, o, t, r, e, a]);
}
function Pl(e, t) {
  let r = e || '/__manifest';
  return t == null ? r : `${t}${r}`.replace(/\/+/g, '/');
}
var rr = 'react-router-manifest-version';
async function la(e, t, r, n, a, o, i, s, l, u) {
  const h = new URLSearchParams();
  h.set('paths', e.sort().join(',')), h.set('version', r.version);
  let c = new URL(Pl(s, i), window.location.origin);
  if (((c.search = h.toString()), c.toString().length > Cl)) {
    Ot.clear();
    return;
  }
  let y;
  try {
    let R = await fetch(c, { signal: u });
    if (R.ok) {
      if (R.status === 204 && R.headers.has('X-Remix-Reload-Document')) {
        if (!t) {
          console.warn(
            'Detected a manifest version mismatch during eager route discovery. The next navigation/fetch to an undiscovered route will result in a new document navigation to sync up with the latest manifest.'
          );
          return;
        }
        try {
          if (sessionStorage.getItem(rr) === r.version) {
            console.error(
              'Unable to discover routes due to manifest version mismatch.'
            );
            return;
          }
          sessionStorage.setItem(rr, r.version);
        } catch {}
        (window.location.href = t),
          console.warn('Detected manifest version mismatch, reloading...'),
          await new Promise(() => {});
      } else if (R.status >= 400) throw new Error(await R.text());
    } else throw new Error(`${R.status} ${R.statusText}`);
    try {
      sessionStorage.removeItem(rr);
    } catch {}
    y = await R.json();
  } catch (R) {
    if (u?.aborted) return;
    throw R;
  }
  let g = new Set(Object.keys(r.routes)),
    E = Object.values(y).reduce(
      (R, x) => (x && !g.has(x.id) && (R[x.id] = x), R),
      {}
    );
  Object.assign(r.routes, E), e.forEach((R) => Ml(R, kt));
  let L = new Set();
  Object.values(E).forEach((R) => {
    R && (!R.parentId || !E[R.parentId]) && L.add(R.parentId);
  }),
    L.forEach((R) => l(R || null, Lr(E, n, null, a, o, R)));
}
function Ml(e, t) {
  if (t.size >= xl) {
    let r = t.values().next().value;
    t.delete(r);
  }
  t.add(e);
}
function Tl(e, t) {
  let r;
  return (...n) => {
    window.clearTimeout(r), (r = window.setTimeout(() => e(...n), t));
  };
}
function Mr() {
  let e = f.useContext(Ve);
  return (
    ge(
      e,
      'You must render this element inside a <DataRouterContext.Provider> element'
    ),
    e
  );
}
function Ht() {
  let e = f.useContext(Qe);
  return (
    ge(
      e,
      'You must render this element inside a <DataRouterStateContext.Provider> element'
    ),
    e
  );
}
var Ut = f.createContext(void 0);
Ut.displayName = 'FrameworkContext';
function Ze() {
  let e = f.useContext(Ut);
  return (
    ge(e, 'You must render this element inside a <HydratedRouter> element'), e
  );
}
function Dl(e, t) {
  let r = f.useContext(Ut),
    [n, a] = f.useState(!1),
    [o, i] = f.useState(!1),
    {
      onFocus: s,
      onBlur: l,
      onMouseEnter: u,
      onMouseLeave: h,
      onTouchStart: c,
    } = t,
    y = f.useRef(null);
  f.useEffect(() => {
    if ((e === 'render' && i(!0), e === 'viewport')) {
      let L = (x) => {
          x.forEach((b) => {
            i(b.isIntersecting);
          });
        },
        R = new IntersectionObserver(L, { threshold: 0.5 });
      return (
        y.current && R.observe(y.current),
        () => {
          R.disconnect();
        }
      );
    }
  }, [e]),
    f.useEffect(() => {
      if (n) {
        let L = setTimeout(() => {
          i(!0);
        }, 100);
        return () => {
          clearTimeout(L);
        };
      }
    }, [n]);
  let g = () => {
      a(!0);
    },
    E = () => {
      a(!1), i(!1);
    };
  return r
    ? e !== 'intent'
      ? [o, y, {}]
      : [
          o,
          y,
          {
            onFocus: it(s, g),
            onBlur: it(l, E),
            onMouseEnter: it(u, g),
            onMouseLeave: it(h, E),
            onTouchStart: it(c, g),
          },
        ]
    : [!1, y, {}];
}
function it(e, t) {
  return (r) => {
    e && e(r), r.defaultPrevented || t(r);
  };
}
function Tr(e, t, r) {
  if (r && !It) return [e[0]];
  if (t) {
    let n = e.findIndex((a) => t[a.route.id] !== void 0);
    return e.slice(0, n + 1);
  }
  return e;
}
var xn = 'data-react-router-critical-css';
function us({ nonce: e }) {
  let { isSpaMode: t, manifest: r, routeModules: n, criticalCss: a } = Ze(),
    { errors: o, matches: i } = Ht(),
    s = Tr(i, o, t),
    l = f.useMemo(() => fl(s, n, r), [s, n, r]);
  return f.createElement(
    f.Fragment,
    null,
    typeof a == 'string'
      ? f.createElement('style', {
          [xn]: '',
          dangerouslySetInnerHTML: { __html: a },
        })
      : null,
    typeof a == 'object'
      ? f.createElement('link', {
          [xn]: '',
          rel: 'stylesheet',
          href: a.href,
          nonce: e,
        })
      : null,
    l.map(({ key: u, link: h }) =>
      xr(h)
        ? f.createElement(sa, { key: u, nonce: e, ...h })
        : f.createElement('link', { key: u, nonce: e, ...h })
    )
  );
}
function sa({ page: e, ...t }) {
  let { router: r } = Mr(),
    n = f.useMemo(() => Ae(r.routes, e, r.basename), [r.routes, e, r.basename]);
  return n ? f.createElement(Ol, { page: e, matches: n, ...t }) : null;
}
function _l(e) {
  let { manifest: t, routeModules: r } = Ze(),
    [n, a] = f.useState([]);
  return (
    f.useEffect(() => {
      let o = !1;
      return (
        pl(e, t, r).then((i) => {
          o || a(i);
        }),
        () => {
          o = !0;
        }
      );
    }, [e, t, r]),
    n
  );
}
function Ol({ page: e, matches: t, ...r }) {
  let n = Me(),
    { manifest: a, routeModules: o } = Ze(),
    { basename: i } = Mr(),
    { loaderData: s, matches: l } = Ht(),
    u = f.useMemo(() => bn(e, t, l, a, n, 'data'), [e, t, l, a, n]),
    h = f.useMemo(() => bn(e, t, l, a, n, 'assets'), [e, t, l, a, n]),
    c = f.useMemo(() => {
      if (e === n.pathname + n.search + n.hash) return [];
      let E = new Set(),
        L = !1;
      if (
        (t.forEach((x) => {
          let b = a.routes[x.route.id];
          !b ||
            !b.hasLoader ||
            ((!u.some((T) => T.route.id === x.route.id) &&
              x.route.id in s &&
              o[x.route.id]?.shouldRevalidate) ||
            b.hasClientLoader
              ? (L = !0)
              : E.add(x.route.id));
        }),
        E.size === 0)
      )
        return [];
      let R = Zn(e, i, 'data');
      return (
        L &&
          E.size > 0 &&
          R.searchParams.set(
            '_routes',
            t
              .filter((x) => E.has(x.route.id))
              .map((x) => x.route.id)
              .join(',')
          ),
        [R.pathname + R.search]
      );
    }, [i, s, n, a, u, t, e, o]),
    y = f.useMemo(() => Cr(h, a), [h, a]),
    g = _l(h);
  return f.createElement(
    f.Fragment,
    null,
    c.map((E) =>
      f.createElement('link', {
        key: E,
        rel: 'prefetch',
        as: 'fetch',
        href: E,
        ...r,
      })
    ),
    y.map((E) =>
      f.createElement('link', { key: E, rel: 'modulepreload', href: E, ...r })
    ),
    g.map(({ key: E, link: L }) =>
      f.createElement('link', { key: E, nonce: r.nonce, ...L })
    )
  );
}
function cs() {
  let { isSpaMode: e, routeModules: t } = Ze(),
    { errors: r, matches: n, loaderData: a } = Ht(),
    o = Me(),
    i = Tr(n, r, e),
    s = null;
  r && (s = r[i[i.length - 1].route.id]);
  let l = [],
    u = null,
    h = [];
  for (let c = 0; c < i.length; c++) {
    let y = i[c],
      g = y.route.id,
      E = a[g],
      L = y.params,
      R = t[g],
      x = [],
      b = {
        id: g,
        data: E,
        loaderData: E,
        meta: [],
        params: y.params,
        pathname: y.pathname,
        handle: y.route.handle,
        error: s,
      };
    if (
      ((h[c] = b),
      R?.meta
        ? (x =
            typeof R.meta == 'function'
              ? R.meta({
                  data: E,
                  loaderData: E,
                  params: L,
                  location: o,
                  matches: h,
                  error: s,
                })
              : Array.isArray(R.meta)
                ? [...R.meta]
                : R.meta)
        : u && (x = [...u]),
      (x = x || []),
      !Array.isArray(x))
    )
      throw new Error(
        'The route at ' +
          y.route.path +
          ` returns an invalid value. All route meta functions must return an array of meta objects.

To reference the meta function API, see https://remix.run/route/meta`
      );
    (b.meta = x), (h[c] = b), (l = [...x]), (u = l);
  }
  return f.createElement(
    f.Fragment,
    null,
    l.flat().map((c) => {
      if (!c) return null;
      if ('tagName' in c) {
        let { tagName: y, ...g } = c;
        if (!Al(y))
          return (
            console.warn(
              `A meta object uses an invalid tagName: ${y}. Expected either 'link' or 'meta'`
            ),
            null
          );
        let E = y;
        return f.createElement(E, { key: JSON.stringify(g), ...g });
      }
      if ('title' in c)
        return f.createElement('title', { key: 'title' }, String(c.title));
      if (
        ('charset' in c &&
          (c.charSet ?? (c.charSet = c.charset), delete c.charset),
        'charSet' in c && c.charSet != null)
      )
        return typeof c.charSet == 'string'
          ? f.createElement('meta', { key: 'charSet', charSet: c.charSet })
          : null;
      if ('script:ld+json' in c)
        try {
          let y = JSON.stringify(c['script:ld+json']);
          return f.createElement('script', {
            key: `script:ld+json:${y}`,
            type: 'application/ld+json',
            dangerouslySetInnerHTML: { __html: el(y) },
          });
        } catch {
          return null;
        }
      return f.createElement('meta', { key: JSON.stringify(c), ...c });
    })
  );
}
function Al(e) {
  return typeof e == 'string' && /^(meta|link)$/.test(e);
}
var It = !1;
function Nl() {
  It = !0;
}
function kl(e) {
  let {
      manifest: t,
      serverHandoffString: r,
      isSpaMode: n,
      renderMeta: a,
      routeDiscovery: o,
      ssr: i,
    } = Ze(),
    { router: s, static: l, staticContext: u } = Mr(),
    { matches: h } = Ht(),
    c = Ko(),
    y = Pr(o, i);
  a && (a.didRenderScripts = !0);
  let g = Tr(h, null, n);
  f.useEffect(() => {
    Nl();
  }, []);
  let E = f.useMemo(() => {
      if (c) return null;
      let b = u
          ? `window.__reactRouterContext = ${r};window.__reactRouterContext.stream = new ReadableStream({start(controller){window.__reactRouterContext.streamController = controller;}}).pipeThrough(new TextEncoderStream());`
          : ' ',
        T = l
          ? `${t.hmr?.runtime ? `import ${JSON.stringify(t.hmr.runtime)};` : ''}${y ? '' : `import ${JSON.stringify(t.url)}`};
${g
  .map((M, D) => {
    let k = `route${D}`,
      m = t.routes[M.route.id];
    ge(m, `Route ${M.route.id} not found in manifest`);
    let {
        clientActionModule: B,
        clientLoaderModule: W,
        clientMiddlewareModule: G,
        hydrateFallbackModule: U,
        module: se,
      } = m,
      Z = [
        ...(B ? [{ module: B, varName: `${k}_clientAction` }] : []),
        ...(W ? [{ module: W, varName: `${k}_clientLoader` }] : []),
        ...(G ? [{ module: G, varName: `${k}_clientMiddleware` }] : []),
        ...(U ? [{ module: U, varName: `${k}_HydrateFallback` }] : []),
        { module: se, varName: `${k}_main` },
      ];
    if (Z.length === 1) return `import * as ${k} from ${JSON.stringify(se)};`;
    let q = Z.map(
        (te) => `import * as ${te.varName} from "${te.module}";`
      ).join(`
`),
      ne = `const ${k} = {${Z.map((te) => `...${te.varName}`).join(',')}};`;
    return [q, ne].join(`
`);
  })
  .join(`
`)}
  ${y ? `window.__reactRouterManifest = ${JSON.stringify(Ll(t, s), null, 2)};` : ''}
  window.__reactRouterRouteModules = {${g.map((M, D) => `${JSON.stringify(M.route.id)}:route${D}`).join(',')}};

import(${JSON.stringify(t.entry.module)});`
          : ' ';
      return f.createElement(
        f.Fragment,
        null,
        f.createElement('script', {
          ...e,
          suppressHydrationWarning: !0,
          dangerouslySetInnerHTML: { __html: b },
          type: void 0,
        }),
        f.createElement('script', {
          ...e,
          suppressHydrationWarning: !0,
          dangerouslySetInnerHTML: { __html: T },
          type: 'module',
          async: !0,
        })
      );
    }, []),
    L =
      It || c
        ? []
        : Il(t.entry.imports.concat(Cr(g, t, { includeHydrateFallback: !0 }))),
    R = typeof t.sri == 'object' ? t.sri : {};
  return (
    sr(
      !c,
      'The <Scripts /> element is a no-op when using RSC and can be safely removed.'
    ),
    It || c
      ? null
      : f.createElement(
          f.Fragment,
          null,
          typeof t.sri == 'object'
            ? f.createElement('script', {
                'rr-importmap': '',
                type: 'importmap',
                suppressHydrationWarning: !0,
                dangerouslySetInnerHTML: {
                  __html: JSON.stringify({ integrity: R }),
                },
              })
            : null,
          y
            ? null
            : f.createElement('link', {
                rel: 'modulepreload',
                href: t.url,
                crossOrigin: e.crossOrigin,
                integrity: R[t.url],
                suppressHydrationWarning: !0,
              }),
          f.createElement('link', {
            rel: 'modulepreload',
            href: t.entry.module,
            crossOrigin: e.crossOrigin,
            integrity: R[t.entry.module],
            suppressHydrationWarning: !0,
          }),
          L.map((x) =>
            f.createElement('link', {
              key: x,
              rel: 'modulepreload',
              href: x,
              crossOrigin: e.crossOrigin,
              integrity: R[x],
              suppressHydrationWarning: !0,
            })
          ),
          E
        )
  );
}
function Il(e) {
  return [...new Set(e)];
}
function $l(...e) {
  return (t) => {
    e.forEach((r) => {
      typeof r == 'function' ? r(t) : r != null && (r.current = t);
    });
  };
}
var ds = class extends f.Component {
  constructor(e) {
    super(e), (this.state = { error: e.error || null, location: e.location });
  }
  static getDerivedStateFromError(e) {
    return { error: e };
  }
  static getDerivedStateFromProps(e, t) {
    return t.location !== e.location
      ? { error: e.error || null, location: e.location }
      : { error: e.error || t.error, location: t.location };
  }
  render() {
    return this.state.error
      ? f.createElement(ua, { error: this.state.error, isOutsideRemixApp: !0 })
      : this.props.children;
  }
};
function ua({ error: e, isOutsideRemixApp: t }) {
  console.error(e);
  let r = f.createElement('script', {
    dangerouslySetInnerHTML: {
      __html: `
        console.log(
          "💿 Hey developer 👋. You can provide a way better UX than this when your app throws errors. Check out https://reactrouter.com/how-to/error-boundary for more information."
        );
      `,
    },
  });
  if (We(e))
    return f.createElement(
      dr,
      { title: 'Unhandled Thrown Response!' },
      f.createElement(
        'h1',
        { style: { fontSize: '24px' } },
        e.status,
        ' ',
        e.statusText
      ),
      r
    );
  let n;
  if (e instanceof Error) n = e;
  else {
    let a =
      e == null
        ? 'Unknown Error'
        : typeof e == 'object' && 'toString' in e
          ? e.toString()
          : JSON.stringify(e);
    n = new Error(a);
  }
  return f.createElement(
    dr,
    { title: 'Application Error!', isOutsideRemixApp: t },
    f.createElement('h1', { style: { fontSize: '24px' } }, 'Application Error'),
    f.createElement(
      'pre',
      {
        style: {
          padding: '2rem',
          background: 'hsla(10, 50%, 50%, 0.1)',
          color: 'red',
          overflow: 'auto',
        },
      },
      n.stack
    ),
    r
  );
}
function dr({ title: e, renderScripts: t, isOutsideRemixApp: r, children: n }) {
  let { routeModules: a } = Ze();
  return a.root?.Layout && !r
    ? n
    : f.createElement(
        'html',
        { lang: 'en' },
        f.createElement(
          'head',
          null,
          f.createElement('meta', { charSet: 'utf-8' }),
          f.createElement('meta', {
            name: 'viewport',
            content: 'width=device-width,initial-scale=1,viewport-fit=cover',
          }),
          f.createElement('title', null, e)
        ),
        f.createElement(
          'body',
          null,
          f.createElement(
            'main',
            { style: { fontFamily: 'system-ui, sans-serif', padding: '2rem' } },
            n,
            t ? f.createElement(kl, null) : null
          )
        )
      );
}
var ca =
  typeof window < 'u' &&
  typeof window.document < 'u' &&
  typeof window.document.createElement < 'u';
try {
  ca && (window.__reactRouterVersion = '7.10.1');
} catch {}
var da = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i,
  fa = f.forwardRef(function (
    {
      onClick: t,
      discover: r = 'render',
      prefetch: n = 'none',
      relative: a,
      reloadDocument: o,
      replace: i,
      state: s,
      target: l,
      to: u,
      preventScrollReset: h,
      viewTransition: c,
      ...y
    },
    g
  ) {
    let { basename: E, unstable_useTransitions: L } = f.useContext(Re),
      R = typeof u == 'string' && da.test(u),
      x,
      b = !1;
    if (typeof u == 'string' && R && ((x = u), ca))
      try {
        let G = new URL(window.location.href),
          U = u.startsWith('//') ? new URL(G.protocol + u) : new URL(u),
          se = Ee(U.pathname, E);
        U.origin === G.origin && se != null
          ? (u = se + U.search + U.hash)
          : (b = !0);
      } catch {
        ie(
          !1,
          `<Link to="${u}"> contains an invalid URL which will probably break when clicked - please update to a valid URL path.`
        );
      }
    let T = Qo(u, { relative: a }),
      [M, D, k] = Dl(n, y),
      m = zl(u, {
        replace: i,
        state: s,
        target: l,
        preventScrollReset: h,
        relative: a,
        viewTransition: c,
        unstable_useTransitions: L,
      });
    function B(G) {
      t && t(G), G.defaultPrevented || m(G);
    }
    let W = f.createElement('a', {
      ...y,
      ...k,
      href: x || T,
      onClick: b || o ? t : B,
      ref: $l(g, D),
      target: l,
      'data-discover': !R && r === 'render' ? 'true' : void 0,
    });
    return M && !R
      ? f.createElement(f.Fragment, null, W, f.createElement(sa, { page: T }))
      : W;
  });
fa.displayName = 'Link';
var Fl = f.forwardRef(function (
  {
    'aria-current': t = 'page',
    caseSensitive: r = !1,
    className: n = '',
    end: a = !1,
    style: o,
    to: i,
    viewTransition: s,
    children: l,
    ...u
  },
  h
) {
  let c = mt(i, { relative: u.relative }),
    y = Me(),
    g = f.useContext(Qe),
    { navigator: E, basename: L } = f.useContext(Re),
    R = g != null && Xl(c) && s === !0,
    x = E.encodeLocation ? E.encodeLocation(c).pathname : c.pathname,
    b = y.pathname,
    T =
      g && g.navigation && g.navigation.location
        ? g.navigation.location.pathname
        : null;
  r ||
    ((b = b.toLowerCase()),
    (T = T ? T.toLowerCase() : null),
    (x = x.toLowerCase())),
    T && L && (T = Ee(T, L) || T);
  const M = x !== '/' && x.endsWith('/') ? x.length - 1 : x.length;
  let D = b === x || (!a && b.startsWith(x) && b.charAt(M) === '/'),
    k =
      T != null &&
      (T === x || (!a && T.startsWith(x) && T.charAt(x.length) === '/')),
    m = { isActive: D, isPending: k, isTransitioning: R },
    B = D ? t : void 0,
    W;
  typeof n == 'function'
    ? (W = n(m))
    : (W = [
        n,
        D ? 'active' : null,
        k ? 'pending' : null,
        R ? 'transitioning' : null,
      ]
        .filter(Boolean)
        .join(' '));
  let G = typeof o == 'function' ? o(m) : o;
  return f.createElement(
    fa,
    {
      ...u,
      'aria-current': B,
      className: W,
      ref: h,
      style: G,
      to: i,
      viewTransition: s,
    },
    typeof l == 'function' ? l(m) : l
  );
});
Fl.displayName = 'NavLink';
var jl = f.forwardRef(
  (
    {
      discover: e = 'render',
      fetcherKey: t,
      navigate: r,
      reloadDocument: n,
      replace: a,
      state: o,
      method: i = Dt,
      action: s,
      onSubmit: l,
      relative: u,
      preventScrollReset: h,
      viewTransition: c,
      ...y
    },
    g
  ) => {
    let { unstable_useTransitions: E } = f.useContext(Re),
      L = Yl(),
      R = Vl(s, { relative: u }),
      x = i.toLowerCase() === 'get' ? 'get' : 'post',
      b = typeof s == 'string' && da.test(s),
      T = (M) => {
        if ((l && l(M), M.defaultPrevented)) return;
        M.preventDefault();
        let D = M.nativeEvent.submitter,
          k = D?.getAttribute('formmethod') || i,
          m = () =>
            L(D || M.currentTarget, {
              fetcherKey: t,
              method: k,
              navigate: r,
              replace: a,
              state: o,
              relative: u,
              preventScrollReset: h,
              viewTransition: c,
            });
        E && r !== !1 ? f.startTransition(() => m()) : m();
      };
    return f.createElement('form', {
      ref: g,
      method: x,
      action: R,
      onSubmit: n ? l : T,
      ...y,
      'data-discover': !b && e === 'render' ? 'true' : void 0,
    });
  }
);
jl.displayName = 'Form';
function Hl({ getKey: e, storageKey: t, ...r }) {
  let n = f.useContext(Ut),
    { basename: a } = f.useContext(Re),
    o = Me(),
    i = br();
  Jl({ getKey: e, storageKey: t });
  let s = f.useMemo(() => {
    if (!n || !e) return null;
    let u = hr(o, i, a, e);
    return u !== o.key ? u : null;
  }, []);
  if (!n || n.isSpaMode) return null;
  let l = ((u, h) => {
    if (!window.history.state || !window.history.state.key) {
      let c = Math.random().toString(32).slice(2);
      window.history.replaceState({ key: c }, '');
    }
    try {
      let y = JSON.parse(sessionStorage.getItem(u) || '{}')[
        h || window.history.state.key
      ];
      typeof y == 'number' && window.scrollTo(0, y);
    } catch (c) {
      console.error(c), sessionStorage.removeItem(u);
    }
  }).toString();
  return f.createElement('script', {
    ...r,
    suppressHydrationWarning: !0,
    dangerouslySetInnerHTML: {
      __html: `(${l})(${JSON.stringify(t || fr)}, ${JSON.stringify(s)})`,
    },
  });
}
Hl.displayName = 'ScrollRestoration';
function ha(e) {
  return `${e} must be used within a data router.  See https://reactrouter.com/en/main/routers/picking-a-router.`;
}
function Dr(e) {
  let t = f.useContext(Ve);
  return V(t, ha(e)), t;
}
function Ul(e) {
  let t = f.useContext(Qe);
  return V(t, ha(e)), t;
}
function zl(
  e,
  {
    target: t,
    replace: r,
    state: n,
    preventScrollReset: a,
    relative: o,
    viewTransition: i,
    unstable_useTransitions: s,
  } = {}
) {
  let l = Zo(),
    u = Me(),
    h = mt(e, { relative: o });
  return f.useCallback(
    (c) => {
      if (Pi(c, t)) {
        c.preventDefault();
        let y = r !== void 0 ? r : Pe(u) === Pe(h),
          g = () =>
            l(e, {
              replace: y,
              state: n,
              preventScrollReset: a,
              relative: o,
              viewTransition: i,
            });
        s ? f.startTransition(() => g()) : g();
      }
    },
    [u, l, h, r, n, t, e, a, o, i, s]
  );
}
var Bl = 0,
  Wl = () => `__${String(++Bl)}__`;
function Yl() {
  let { router: e } = Dr('useSubmit'),
    { basename: t } = f.useContext(Re),
    r = di(),
    n = e.fetch,
    a = e.navigate;
  return f.useCallback(
    async (o, i = {}) => {
      let { action: s, method: l, encType: u, formData: h, body: c } = Di(o, t);
      if (i.navigate === !1) {
        let y = i.fetcherKey || Wl();
        await n(y, r, i.action || s, {
          preventScrollReset: i.preventScrollReset,
          formData: h,
          body: c,
          formMethod: i.method || l,
          formEncType: i.encType || u,
          flushSync: i.flushSync,
        });
      } else
        await a(i.action || s, {
          preventScrollReset: i.preventScrollReset,
          formData: h,
          body: c,
          formMethod: i.method || l,
          formEncType: i.encType || u,
          replace: i.replace,
          state: i.state,
          fromRouteId: r,
          flushSync: i.flushSync,
          viewTransition: i.viewTransition,
        });
    },
    [n, a, t, r]
  );
}
function Vl(e, { relative: t } = {}) {
  let { basename: r } = f.useContext(Re),
    n = f.useContext(xe);
  V(n, 'useFormAction must be used inside a RouteContext');
  let [a] = n.matches.slice(-1),
    o = { ...mt(e || '.', { relative: t }) },
    i = Me();
  if (e == null) {
    o.search = i.search;
    let s = new URLSearchParams(o.search),
      l = s.getAll('index');
    if (l.some((h) => h === '')) {
      s.delete('index'),
        l.filter((c) => c).forEach((c) => s.append('index', c));
      let h = s.toString();
      o.search = h ? `?${h}` : '';
    }
  }
  return (
    (!e || e === '.') &&
      a.route.index &&
      (o.search = o.search ? o.search.replace(/^\?/, '?index&') : '?index'),
    r !== '/' && (o.pathname = o.pathname === '/' ? r : Le([r, o.pathname])),
    Pe(o)
  );
}
var fr = 'react-router-scroll-positions',
  Mt = {};
function hr(e, t, r, n) {
  let a = null;
  return (
    n &&
      (r !== '/'
        ? (a = n({ ...e, pathname: Ee(e.pathname, r) || e.pathname }, t))
        : (a = n(e, t))),
    a == null && (a = e.key),
    a
  );
}
function Jl({ getKey: e, storageKey: t } = {}) {
  let { router: r } = Dr('useScrollRestoration'),
    { restoreScrollPosition: n, preventScrollReset: a } = Ul(
      'useScrollRestoration'
    ),
    { basename: o } = f.useContext(Re),
    i = Me(),
    s = br(),
    l = fi();
  f.useEffect(
    () => (
      (window.history.scrollRestoration = 'manual'),
      () => {
        window.history.scrollRestoration = 'auto';
      }
    ),
    []
  ),
    Gl(
      f.useCallback(() => {
        if (l.state === 'idle') {
          let u = hr(i, s, o, e);
          Mt[u] = window.scrollY;
        }
        try {
          sessionStorage.setItem(t || fr, JSON.stringify(Mt));
        } catch (u) {
          ie(
            !1,
            `Failed to save scroll positions in sessionStorage, <ScrollRestoration /> will not work properly (${u}).`
          );
        }
        window.history.scrollRestoration = 'auto';
      }, [l.state, e, o, i, s, t])
    ),
    typeof document < 'u' &&
      (f.useLayoutEffect(() => {
        try {
          let u = sessionStorage.getItem(t || fr);
          u && (Mt = JSON.parse(u));
        } catch {}
      }, [t]),
      f.useLayoutEffect(() => {
        let u = r?.enableScrollRestoration(
          Mt,
          () => window.scrollY,
          e ? (h, c) => hr(h, c, o, e) : void 0
        );
        return () => u && u();
      }, [r, o, e]),
      f.useLayoutEffect(() => {
        if (n !== !1) {
          if (typeof n == 'number') {
            window.scrollTo(0, n);
            return;
          }
          try {
            if (i.hash) {
              let u = document.getElementById(
                decodeURIComponent(i.hash.slice(1))
              );
              if (u) {
                u.scrollIntoView();
                return;
              }
            }
          } catch {
            ie(
              !1,
              `"${i.hash.slice(1)}" is not a decodable element ID. The view will not scroll to it.`
            );
          }
          a !== !0 && window.scrollTo(0, 0);
        }
      }, [i, n, a]));
}
function Gl(e, t) {
  let { capture: r } = {};
  f.useEffect(() => {
    let n = r != null ? { capture: r } : void 0;
    return (
      window.addEventListener('pagehide', e, n),
      () => {
        window.removeEventListener('pagehide', e, n);
      }
    );
  }, [e, r]);
}
function Xl(e, { relative: t } = {}) {
  let r = f.useContext(wr);
  V(
    r != null,
    "`useViewTransitionState` must be used within `react-router-dom`'s `RouterProvider`.  Did you accidentally import `RouterProvider` from `react-router`?"
  );
  let { basename: n } = Dr('useViewTransitionState'),
    a = mt(e, { relative: t });
  if (!r.isTransitioning) return !1;
  let o = Ee(r.currentLocation.pathname, n) || r.currentLocation.pathname,
    i = Ee(r.nextLocation.pathname, n) || r.nextLocation.pathname;
  return At(a.pathname, i) != null || At(a.pathname, o) != null;
}
export {
  Ye as E,
  Ut as F,
  us as L,
  cs as M,
  rl as N,
  rs as O,
  Ia as R,
  Hl as S,
  as as a,
  kl as b,
  ka as c,
  V as d,
  ds as e,
  ts as f,
  dl as g,
  Lr as h,
  We as i,
  Kl as j,
  Ql as k,
  ls as l,
  Ae as m,
  os as n,
  ql as o,
  is as p,
  Zl as q,
  f as r,
  Sl as s,
  es as t,
  ss as u,
  ns as w,
};
