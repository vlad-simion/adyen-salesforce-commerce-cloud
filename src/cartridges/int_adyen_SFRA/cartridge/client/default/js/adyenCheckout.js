import store from "../../../store";
import { paymentMethodsConfiguration } from "./adyenCheckout/paymentMethodsConfiguration";

const { card } = paymentMethodsConfiguration;

$("#dwfrm_billing").submit(function (e) {
  e.preventDefault();

  const form = $(this);
  const url = form.attr("action");

  $.ajax({
    type: "POST",
    url: url,
    data: form.serialize(),
    async: false,
    success: function (data) {
      store.formErrorsExist = "fieldErrors" in data;
    },
  });
});

store.checkoutConfiguration.onChange = function (state) {
  const type = state.data.paymentMethod.type;
  store.isValid = state.isValid;
  if (!store.componentsObj[type]) {
    store.componentsObj[type] = {};
  }
  store.componentsObj[type].isValid = store.isValid;
  store.componentsObj[type].stateData = state.data;
};
store.checkoutConfiguration.showPayButton = false;

store.checkoutConfiguration.paymentMethodsConfiguration = {
  card,
  boletobancario: {
    personalDetailsRequired: true, // turn personalDetails section on/off
    billingAddressRequired: false, // turn billingAddress section on/off
    showEmailAddress: false, // allow shopper to specify their email address

    // Optionally prefill some fields, here all fields are filled:
    data: {
      firstName: document.getElementById("shippingFirstNamedefault").value,
      lastName: document.getElementById("shippingLastNamedefault").value,
    },
  },
  paypal: {
    environment: window.Configuration.environment,
    intent: "capture",
    onSubmit: (state, component) => {
      assignPaymentMethodValue();
      document.querySelector("#adyenStateData").value = JSON.stringify(
        store.selectedPayment.stateData
      );
      paymentFromComponent(state.data, component);
    },
    onCancel: (data, component) => {
      paymentFromComponent({ cancelTransaction: true }, component);
      component.setStatus("ready");
    },
    onError: (error, component) => {
      if (component) {
        component.setStatus("ready");
      }
    },
    onAdditionalDetails: (state) => {
      document.querySelector("#additionalDetailsHidden").value = JSON.stringify(
        state.data
      );
      document.querySelector("#showConfirmationForm").submit();
    },
    onClick: (data, actions) => {
      $("#dwfrm_billing").trigger("submit");
      if (store.formErrorsExist) {
        return actions.reject();
      }
    },
  },
  afterpay_default: {
    visibility: {
      personalDetails: "editable",
      billingAddress: "hidden",
      deliveryAddress: "hidden",
    },
    data: {
      personalDetails: {
        firstName: document.querySelector("#shippingFirstNamedefault").value,
        lastName: document.querySelector("#shippingLastNamedefault").value,
        telephoneNumber: document.querySelector("#shippingPhoneNumberdefault")
          .value,
        shopperEmail: document.querySelector("#email").value,
      },
    },
  },
  facilypay_3x: {
    visibility: {
      personalDetails: "editable",
      billingAddress: "hidden",
      deliveryAddress: "hidden",
    },
    data: {
      personalDetails: {
        firstName: document.querySelector("#shippingFirstNamedefault").value,
        lastName: document.querySelector("#shippingLastNamedefault").value,
        telephoneNumber: document.querySelector("#shippingPhoneNumberdefault")
          .value,
        shopperEmail: document.querySelector("#email").value,
      },
    },
  },
};
if (window.installments) {
  try {
    const installments = JSON.parse(window.installments);
    store.checkoutConfiguration.paymentMethodsConfiguration.card.installments = installments;
  } catch (e) {} // eslint-disable-line no-empty
}
if (window.paypalMerchantID !== "null") {
  store.checkoutConfiguration.paymentMethodsConfiguration.paypal.merchantId =
    window.paypalMerchantID;
}

function displaySelectedMethod(type) {
  store.selectedMethod = type;
  resetPaymentMethod();
  if (type !== "paypal") {
    document.querySelector('button[value="submit-payment"]').disabled = false;
  } else {
    document.querySelector('button[value="submit-payment"]').disabled = true;
  }
  document
    .querySelector(`#component_${type}`)
    .setAttribute("style", "display:block");
}

function unmountComponents() {
  const promises = Object.entries(store.componentsObj).map(function ([
    key,
    val,
  ]) {
    delete store.componentsObj[key];
    return resolveUnmount(key, val);
  });
  return Promise.all(promises);
}

function resolveUnmount(key, val) {
  try {
    return Promise.resolve(val.node.unmount(`component_${key}`));
  } catch (e) {
    // try/catch block for val.unmount
    return Promise.resolve(false);
  }
}

function isMethodTypeBlocked(methodType) {
  const blockedMethods = [
    "bcmc_mobile_QR",
    "applepay",
    "cup",
    "wechatpay",
    "wechatpay_pos",
    "wechatpaySdk",
    "wechatpayQr",
  ];
  return blockedMethods.includes(methodType);
}

async function renderGenericComponent() {
  if (Object.keys(store.componentsObj).length !== 0) {
    await unmountComponents();
  }
  getPaymentMethods(function (data) {
    let paymentMethod;
    let i;
    store.checkoutConfiguration.paymentMethodsResponse =
      data.AdyenPaymentMethods;
    if (data.amount) {
      store.checkoutConfiguration.amount = data.amount;
    }
    if (data.countryCode) {
      store.checkoutConfiguration.countryCode = data.countryCode;
    }
    store.checkout = new AdyenCheckout(store.checkoutConfiguration);

    document.querySelector("#paymentMethodsList").innerHTML = "";

    if (data.AdyenPaymentMethods.storedPaymentMethods) {
      for (
        i = 0;
        i < store.checkout.paymentMethodsResponse.storedPaymentMethods.length;
        i++
      ) {
        paymentMethod =
          store.checkout.paymentMethodsResponse.storedPaymentMethods[i];
        if (paymentMethod.supportedShopperInteractions.includes("Ecommerce")) {
          renderPaymentMethod(paymentMethod, true, data.ImagePath);
        }
      }
    }

    data.AdyenPaymentMethods.paymentMethods.forEach((pm, i) => {
      !isMethodTypeBlocked(pm.type) &&
        renderPaymentMethod(
          pm,
          false,
          data.ImagePath,
          data.AdyenDescriptions[i].description
        );
    });

    if (
      data.AdyenConnectedTerminals &&
      data.AdyenConnectedTerminals.uniqueTerminalIds &&
      data.AdyenConnectedTerminals.uniqueTerminalIds.length > 0
    ) {
      const posTerminals = document.querySelector("#adyenPosTerminals");
      while (posTerminals.firstChild) {
        posTerminals.removeChild(posTerminals.firstChild);
      }
      addPosTerminals(data.AdyenConnectedTerminals.uniqueTerminalIds);
    }
    const firstPaymentMethod = document.querySelector(
      "input[type=radio][name=brandCode]"
    );
    firstPaymentMethod.checked = true;
    displaySelectedMethod(firstPaymentMethod.value);
  });
}

function renderPaymentMethod(
  paymentMethod,
  storedPaymentMethodBool,
  path,
  description = null
) {
  let node;
  const paymentMethodsUI = document.querySelector("#paymentMethodsList");

  const li = document.createElement("li");
  const paymentMethodID = storedPaymentMethodBool
    ? `storedCard${paymentMethod.id}`
    : paymentMethod.type;
  const isSchemeNotStored =
    paymentMethod.type === "scheme" && !storedPaymentMethodBool;
  const paymentMethodImage = storedPaymentMethodBool
    ? `${path}${paymentMethod.brand}.png`
    : `${path}${paymentMethod.type}.png`;
  const cardImage = `${path}card.png`;
  const imagePath = isSchemeNotStored ? cardImage : paymentMethodImage;
  const label = storedPaymentMethodBool
    ? `${paymentMethod.name} ${store.MASKED_CC_PREFIX}${paymentMethod.lastFour}`
    : `${paymentMethod.name}`;
  let liContents = `
                              <input name="brandCode" type="radio" value="${paymentMethodID}" id="rb_${paymentMethodID}">
                              <img class="paymentMethod_img" src="${imagePath}" ></img>
                              <label id="lb_${paymentMethodID}" for="rb_${paymentMethodID}">${label}</label>
                             `;
  if (description) {
    liContents += `<p>${description}</p>`;
  }
  const container = document.createElement("div");
  li.innerHTML = liContents;
  li.classList.add("paymentMethod");

  if (storedPaymentMethodBool) {
    node = store.checkout.create("card", paymentMethod);
    if (!store.componentsObj[paymentMethodID]) {
      store.componentsObj[paymentMethodID] = {};
    }
    store.componentsObj[paymentMethodID].node = node;
  } else {
    const fallback = getFallback(paymentMethod.type);
    if (fallback) {
      const template = document.createElement("template");
      template.innerHTML = fallback;
      container.append(template.content);
    } else {
      try {
        node = store.checkout.create(paymentMethod.type);
        if (!store.componentsObj[paymentMethodID]) {
          store.componentsObj[paymentMethodID] = {};
        }
        store.componentsObj[paymentMethodID].node = node;
      } catch (e) {} // eslint-disable-line no-empty
    }
  }
  container.classList.add("additionalFields");
  container.setAttribute("id", `component_${paymentMethodID}`);
  container.setAttribute("style", "display:none");

  li.append(container);
  paymentMethodsUI.append(li);

  node && node.mount(container);

  const input = document.querySelector(`#rb_${paymentMethodID}`);
  input.onchange = (event) => {
    displaySelectedMethod(event.target.value);
  };

  if (store.componentsObj[paymentMethodID] && !container.childNodes[0]) {
    store.componentsObj[paymentMethodID].isValid = true;
  }
}

// eslint-disable-next-line no-unused-vars
function addPosTerminals(terminals) {
  const dd_terminals = document.createElement("select");
  dd_terminals.id = "terminalList";
  for (const t in terminals) {
    const option = document.createElement("option");
    option.value = terminals[t];
    option.text = terminals[t];
    dd_terminals.appendChild(option);
  }
  document.querySelector("#adyenPosTerminals").append(dd_terminals);
}

function resetPaymentMethod() {
  $("#requiredBrandCode").hide();
  $("#selectedIssuer").val("");
  $("#adyenIssuerName").val("");
  $("#dateOfBirth").val("");
  $("#telephoneNumber").val("");
  $("#gender").val("");
  $("#bankAccountOwnerName").val("");
  $("#bankAccountNumber").val("");
  $("#bankLocationId").val("");
  $(".additionalFields").hide();
}

function getPaymentMethods(paymentMethods) {
  $.ajax({
    url: "Adyen-GetPaymentMethods",
    type: "get",
    success: function (data) {
      paymentMethods(data);
    },
  });
}

function paymentFromComponent(data, component) {
  $.ajax({
    url: "Adyen-PaymentFromComponent",
    type: "post",
    data: { data: JSON.stringify(data) },
    success: function (data) {
      if (data.fullResponse && data.fullResponse.action) {
        component.handleAction(data.fullResponse.action);
      } else {
        component.setStatus("ready");
        component.reject("Payment Refused");
      }
    },
  }).fail(function () {});
}

//Submit the payment
$('button[value="submit-payment"]').on("click", function () {
  if (document.querySelector("#selectedPaymentOption").value === "AdyenPOS") {
    document.querySelector("#terminalId").value = document.querySelector(
      "#terminalList"
    ).value;
    return true;
  }

  assignPaymentMethodValue();
  validateComponents();
  return showValidation();
});

function assignPaymentMethodValue() {
  const adyenPaymentMethod = document.querySelector("#adyenPaymentMethodName");
  adyenPaymentMethod.value = document.querySelector(
    `#lb_${store.selectedMethod}`
  ).innerHTML;
}

function showValidation() {
  let input;
  if (store.selectedPayment && !store.selectedPayment.isValid) {
    store.selectedPayment.node.showValidation();
    return false;
  } else if (store.selectedMethod === "ach") {
    let inputs = document.querySelectorAll("#component_ach > input");
    inputs = Object.values(inputs).filter(function (input) {
      return !(input.value && input.value.length > 0);
    });
    for (input of inputs) {
      input.classList.add("adyen-checkout__input--error");
    }
    if (inputs.length > 0) {
      return false;
    }
    return true;
  } else if (store.selectedMethod === "ratepay") {
    input = document.querySelector("#dateOfBirthInput");
    if (!(input.value && input.value.length > 0)) {
      input.classList.add("adyen-checkout__input--error");
      return false;
    }
    return true;
  }
  return true;
}

function validateCustomInputField(input) {
  if (input.value === "") {
    input.classList.add("adyen-checkout__input--error");
  } else if (input.value.length > 0) {
    input.classList.remove("adyen-checkout__input--error");
  }
}

function validateComponents() {
  if (document.querySelector("#component_ach")) {
    const inputs = document.querySelectorAll("#component_ach > input");
    for (const input of inputs) {
      input.onchange = function () {
        validateCustomInputField(this);
      };
    }
  }
  if (document.querySelector("#dateOfBirthInput")) {
    document.querySelector("#dateOfBirthInput").onchange = function () {
      validateCustomInputField(this);
    };
  }

  let stateData;
  if (store.selectedPayment && store.selectedPayment.stateData) {
    stateData = store.selectedPayment.stateData;
  } else {
    stateData = { paymentMethod: { type: store.selectedMethod } };
  }

  if (store.selectedMethod === "ach") {
    const bankAccount = {
      ownerName: document.querySelector("#bankAccountOwnerNameValue").value,
      bankAccountNumber: document.querySelector("#bankAccountNumberValue")
        .value,
      bankLocationId: document.querySelector("#bankLocationIdValue").value,
    };
    stateData.paymentMethod = {
      ...stateData.paymentMethod,
      bankAccount: bankAccount,
    };
  } else if (store.selectedMethod === "ratepay") {
    if (
      document.querySelector("#genderInput").value &&
      document.querySelector("#dateOfBirthInput").value
    ) {
      stateData.shopperName = {
        gender: document.querySelector("#genderInput").value,
      };
      stateData.dateOfBirth = document.querySelector("#dateOfBirthInput").value;
    }
  }
  document.querySelector("#adyenStateData").value = JSON.stringify(stateData);
}

function getFallback(paymentMethod) {
  const ach = `<div id="component_ach">
                    <span class="adyen-checkout__label">Bank Account Owner Name</span>
                    <input type="text" id="bankAccountOwnerNameValue" class="adyen-checkout__input">
                    <span class="adyen-checkout__label">Bank Account Number</span>
                    <input type="text" id="bankAccountNumberValue" class="adyen-checkout__input" maxlength="17" >
                    <span class="adyen-checkout__label">Routing Number</span>
                    <input type="text" id="bankLocationIdValue" class="adyen-checkout__input" maxlength="9" >
                 </div>`;

  const ratepay = `<span class="adyen-checkout__label">Gender</span>
                    <select id="genderInput" class="adyen-checkout__input">
                        <option value="MALE">Male</option>
                        <option value="FEMALE">Female</option>
                    </select>
                    <span class="adyen-checkout__label">Date of birth</span>
                    <input id="dateOfBirthInput" class="adyen-checkout__input" type="date"/>`;

  const fallback = { ach: ach, ratepay: ratepay };
  return fallback[paymentMethod];
}

module.exports = {
  methods: {
    renderGenericComponent: renderGenericComponent,
  },
};