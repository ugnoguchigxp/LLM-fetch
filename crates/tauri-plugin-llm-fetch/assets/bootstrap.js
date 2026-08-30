(() => {
  "use strict";
  const global = globalThis;
  const defineProperty = Object.defineProperty;
  const freeze = Object.freeze;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const reflectApply = Reflect.apply;
  const arrayFrom = Array.from;
  const arrayIncludesMethod = Array.prototype.includes;
  const arrayJoinMethod = Array.prototype.join;
  const arrayPopMethod = Array.prototype.pop;
  const arrayPushMethod = Array.prototype.push;
  const arraySliceMethod = Array.prototype.slice;
  const dateNowMethod = Date.now;
  const eventTargetAddEventListenerMethod = EventTarget.prototype.addEventListener;
  const stringReplaceMethod = String.prototype.replace;
  const stringIncludesMethod = String.prototype.includes;
  const stringSliceMethod = String.prototype.slice;
  const stringStartsWithMethod = String.prototype.startsWith;
  const stringToLowerCaseMethod = String.prototype.toLowerCase;
  const stringTrimMethod = String.prototype.trim;
  const elementGetAttributeMethod = Element.prototype.getAttribute;
  const elementHasAttributeMethod = Element.prototype.hasAttribute;
  const styleGetPropertyValueMethod = CSSStyleDeclaration.prototype.getPropertyValue;
  const nodeListItemMethod = NodeList.prototype.item;
  const namedNodeMapItemMethod = NamedNodeMap.prototype.item;
  const jsonStringify = JSON.stringify;
  const promiseReject = Promise.reject.bind(Promise);
  const DOMExceptionCtor = DOMException;
  const TypeErrorCtor = TypeError;
  const textEncoder = new TextEncoder();
  const encode = textEncoder.encode.bind(textEncoder);
  const getComputedStyle = global.getComputedStyle?.bind(global);
  const findGetter = (prototype, name) => {
    let current = prototype;
    while (current) {
      const descriptor = getOwnPropertyDescriptor(current, name);
      if (descriptor?.get) return descriptor.get;
      current = getPrototypeOf(current);
    }
    return undefined;
  };
  const nodeTypeGetter = findGetter(Node.prototype, "nodeType");
  const nodeValueGetter = findGetter(Node.prototype, "nodeValue");
  const childNodesGetter = findGetter(Node.prototype, "childNodes");
  const localNameGetter = findGetter(Element.prototype, "localName");
  const attributesGetter = findGetter(Element.prototype, "attributes");
  const nodeListLengthGetter = findGetter(NodeList.prototype, "length");
  const namedNodeMapLengthGetter = findGetter(NamedNodeMap.prototype, "length");
  const templateContentGetter = global.HTMLTemplateElement
    ? findGetter(global.HTMLTemplateElement.prototype, "content")
    : undefined;
  const attrNameGetter = global.Attr ? findGetter(global.Attr.prototype, "name") : undefined;
  const attrValueGetter = global.Attr ? findGetter(global.Attr.prototype, "value") : undefined;
  const documentPrototype = getPrototypeOf(global.document);
  const documentElementGetter = findGetter(documentPrototype, "documentElement");
  const getter = (method, target) => reflectApply(method, target, []);

  const blocked = (name) => {
    const unavailable = function () {
      throw new TypeErrorCtor(`${name} is disabled in the llm-fetch worker`);
    };
    try {
      defineProperty(unavailable, "name", { value: `Blocked${name}` });
    } catch (_) {}
    return unavailable;
  };
  const blockedAsync = (name) => {
    const unavailable = function () {
      return promiseReject(new DOMExceptionCtor("Blocked by llm-fetch", "NotAllowedError"));
    };
    try {
      defineProperty(unavailable, "name", { value: `Blocked${name}` });
    } catch (_) {}
    return unavailable;
  };
  const blockedValue = (name, value) => {
    const unavailable = function () {
      return value;
    };
    try {
      defineProperty(unavailable, "name", { value: `Blocked${name}` });
    } catch (_) {}
    return unavailable;
  };
  let hardeningComplete = true;
  try {
    global.name = "";
  } catch (_) {
    hardeningComplete = false;
  }
  const enforce = (target, name, value) => {
    if (!target) return;
    try {
      defineProperty(target, name, {
        configurable: false,
        enumerable: false,
        writable: false,
        value,
      });
    } catch (_) {
      try {
        target[name] = value;
      } catch (_) {}
      hardeningComplete = false;
      return;
    }
    try {
      const descriptor = getOwnPropertyDescriptor(target, name);
      if (
        target[name] !== value ||
        !descriptor ||
        descriptor.configurable ||
        descriptor.writable
      ) hardeningComplete = false;
    } catch (_) {
      hardeningComplete = false;
    }
  };

  for (const name of [
    "WebSocket",
    "WebTransport",
    "Worker",
    "SharedWorker",
    "EventSource",
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
  ]) {
    enforce(global, name, blocked(name));
  }
  enforce(global, "open", blocked("window.open"));
  enforce(global.Navigator?.prototype, "sendBeacon", blocked("sendBeacon"));
  enforce(global.Navigator?.prototype, "share", blockedAsync("navigator.share"));
  enforce(global.ServiceWorkerContainer?.prototype, "register", blocked("serviceWorker.register"));
  enforce(global.ServiceWorkerRegistration?.prototype, "showNotification", blocked("showNotification"));
  enforce(global.MediaDevices?.prototype, "getUserMedia", blockedAsync("mediaDevices.getUserMedia"));
  enforce(global.MediaDevices?.prototype, "getDisplayMedia", blockedAsync("mediaDevices.getDisplayMedia"));
  enforce(global.Geolocation?.prototype, "getCurrentPosition", blocked("geolocation.getCurrentPosition"));
  enforce(global.Geolocation?.prototype, "watchPosition", blocked("geolocation.watchPosition"));
  for (const name of ["read", "readText", "write", "writeText"]) {
    enforce(global.Clipboard?.prototype, name, blockedAsync(`clipboard.${name}`));
  }
  for (const name of ["create", "get", "store", "preventSilentAccess"]) {
    enforce(global.CredentialsContainer?.prototype, name, blockedAsync(`credentials.${name}`));
  }
  enforce(global.USB?.prototype, "requestDevice", blockedAsync("usb.requestDevice"));
  enforce(global.Serial?.prototype, "requestPort", blockedAsync("serial.requestPort"));
  enforce(global.HID?.prototype, "requestDevice", blockedAsync("hid.requestDevice"));
  enforce(global.Bluetooth?.prototype, "requestDevice", blockedAsync("bluetooth.requestDevice"));
  for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) {
    enforce(global, name, blockedAsync(name));
  }
  enforce(global, "alert", blockedValue("alert", undefined));
  enforce(global, "confirm", blockedValue("confirm", false));
  enforce(global, "prompt", blockedValue("prompt", null));
  enforce(global, "print", blockedValue("print", undefined));
  enforce(global.Notification, "requestPermission", blockedAsync("Notification.requestPermission"));

  const MutationObserverCtor = global.MutationObserver;
  const documentElement = () => getter(documentElementGetter, global.document);
  const now = () => reflectApply(dateNowMethod, Date, []);
  let revision = 0;
  let lastMutation = now();
  let mutationObserver = null;
  const observe = () => {
    const root = documentElement();
    if (!root || !MutationObserverCtor) return false;
    mutationObserver = new MutationObserverCtor(() => {
      revision += 1;
      lastMutation = now();
    });
    mutationObserver.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    return true;
  };
  if (!observe()) {
    reflectApply(eventTargetAddEventListenerMethod, global.document, [
      "DOMContentLoaded", observe, { once: true },
    ]);
  }

  const state = freeze({
    arrayFrom,
    arrayIncludes: (array, value) => reflectApply(arrayIncludesMethod, array, [value]),
    arrayJoin: (array, separator) => reflectApply(arrayJoinMethod, array, [separator]),
    arrayPop: (array) => reflectApply(arrayPopMethod, array, []),
    arrayPush: (array, value) => reflectApply(arrayPushMethod, array, [value]),
    arraySlice: (array, start, end) => reflectApply(arraySliceMethod, array, [start, end]),
    attributes: (element) => getter(attributesGetter, element),
    attributeAt: (attributes, index) => reflectApply(namedNodeMapItemMethod, attributes, [index]),
    attributeCount: (attributes) => getter(namedNodeMapLengthGetter, attributes),
    attributeName: (attribute) => getter(attrNameGetter, attribute),
    attributeValue: (attribute) => getter(attrValueGetter, attribute),
    childNodes: (node) => getter(childNodesGetter, node),
    childAt: (children, index) => reflectApply(nodeListItemMethod, children, [index]),
    childCount: (children) => getter(nodeListLengthGetter, children),
    defineProperty,
    documentElement,
    elementGetAttribute: (element, name) => reflectApply(elementGetAttributeMethod, element, [name]),
    elementHasAttribute: (element, name) => reflectApply(elementHasAttributeMethod, element, [name]),
    encode,
    freeze,
    getComputedStyle,
    jsonStringify,
    localName: (element) => getter(localNameGetter, element),
    mathCeil: Math.ceil,
    nodeType: (node) => getter(nodeTypeGetter, node),
    nodeValue: (node) => getter(nodeValueGetter, node),
    number: Number,
    reflectApply,
    string: String,
    stringIncludes: (value, search) => reflectApply(stringIncludesMethod, value, [search]),
    stringReplace: (value, pattern, replacement) => reflectApply(stringReplaceMethod, value, [pattern, replacement]),
    stringSlice: (value, start, end) => reflectApply(stringSliceMethod, value, [start, end]),
    stringStartsWith: (value, search) => reflectApply(stringStartsWithMethod, value, [search]),
    stringToLowerCase: (value) => reflectApply(stringToLowerCaseMethod, value, []),
    stringTrim: (value) => reflectApply(stringTrimMethod, value, []),
    styleProperty: (style, name) => reflectApply(styleGetPropertyValueMethod, style, [name]),
    hardeningComplete,
    templateContent: (element) => getter(templateContentGetter, element),
    mutationState: () => freeze({
      revision,
      lastMutation,
      observerActive: mutationObserver !== null,
    }),
  });
  try {
    defineProperty(global, "__LLM_FETCH_BOOTSTRAP__", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: state,
    });
  } catch (_) {}
})();
