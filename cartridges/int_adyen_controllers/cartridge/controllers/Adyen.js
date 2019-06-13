'use strict';

/* API Includes */
var Resource = require('dw/web/Resource');
var URLUtils = require('dw/web/URLUtils');
var logger = require('dw/system/Logger').getLogger('Adyen', 'adyen');
var OrderMgr = require('dw/order/OrderMgr');
var BasketMgr = require('dw/order/BasketMgr');
var Site = require('dw/system/Site');
var Status = require('dw/system/Status');
var Transaction = require('dw/system/Transaction');


/* Script Modules */
var app = require('app_storefront_controllers/cartridge/scripts/app');
var guard = require('app_storefront_controllers/cartridge/scripts/guard');
var AdyenHelper = require('int_adyen_overlay/cartridge/scripts/util/AdyenHelper');
var OrderModel = app.getModel('Order');
var Logger = require('dw/system/Logger');

const EXTERNAL_PLATFORM_VERSION = "SiteGenesis";
/**
 * Controller for all storefront processes.
 *
 * @module controllers/Adyen
 */

/**
 * Called by Adyen to update status of payments. It should always display [accepted] when finished.
 */
function notify() {
    var	checkAuth = require('int_adyen_overlay/cartridge/scripts/checkNotificationAuth');
	
    var status = checkAuth.check(request);
    if (!status) {
    	app.getView().render('error');
    	return {};
	}

	var	handleNotify = require('int_adyen_overlay/cartridge/scripts/handleNotify');

	Transaction.begin();
	var success = handleNotify.notifyHttpParameterMap(request.httpParameterMap);

	if(success){
		Transaction.commit();
		app.getView().render('notify');
	}
	else {
		Transaction.rollback();
	}


}

/**
 * Redirect to Adyen after saving order etc.
 */
function redirect(order, redirectUrl) { 
	response.redirect(redirectUrl);
}

/**
 * Show confirmation after return from Adyen
 */
function showConfirmation() {
	var payLoad = request.httpParameterMap.payload.value;
	//redirect to payment/details
	var adyenCheckout = require('int_adyen_overlay/cartridge/scripts/adyenCheckout');
	var requestObject = {};
	requestObject['details'] = {};
	requestObject.details['payload'] = payLoad;
	var result = adyenCheckout.doPaymentDetailsCall(requestObject);
	var orderNumber = result.merchantReference;

	if (result.resultCode == 'Authorised' || result.resultCode == 'Pending') {
		orderConfirm(orderNumber);
	} else {
		var OrderMgr = require('dw/order/OrderMgr');
		var order = OrderMgr.getOrder(orderNumber);
		// fail order
		Transaction.wrap(function () {
			OrderMgr.failOrder(order);
		});
		Logger.getLogger("Adyen").error("Payment failed, result: " + JSON.stringify(result));
		// should be assingned by previous calls or not
		var errorStatus = new dw.system.Status(dw.system.Status.ERROR, "confirm.error.declined");

		app.getController('COSummary').Start({
			PlaceOrderError: errorStatus
		});
	}

	return {};
}

/**
 * Separated order confirm for Credit cards and APM's.
 */
function orderConfirm(orderNo){
	var order = null;
	if (orderNo) {
		order = OrderMgr.getOrder(orderNo);
	}
	if (!order) {
		app.getController('Error').Start();
		return {};
	}
	app.getController('COSummary').ShowConfirmation(order);
}

/**
 * Make a request to Adyen to get payment methods based on countryCode. Called from COBilling-Start
 */
function getPaymentMethods(cart) {
    if (Site.getCurrent().getCustomPreferenceValue("Adyen_directoryLookup")) {
    	var Locale = require('dw/util/Locale');
        var countryCode = Locale.getLocale(request.getLocale()).country;       
        var currentBasket = BasketMgr.getCurrentBasket();
        if (currentBasket.getShipments().length > 0 && currentBasket.getShipments()[0].shippingAddress) {
            countryCode = currentBasket.getShipments()[0].shippingAddress.getCountryCode().value.toUpperCase();
        }
        var	getPaymentMethods = require('int_adyen_overlay/cartridge/scripts/adyenGetPaymentMethods');
        var paymentMethods = getPaymentMethods.getMethods(cart.object, countryCode).paymentMethods;
        return paymentMethods.filter(function (method) { 
        	return !isMethodTypeBlocked(method.type); 
        });
    }
    
    return {};
}

/**
 * Checks if payment method is blocked
 */
function isMethodTypeBlocked(methodType)
{
	if (methodType.indexOf('bcmc_mobile_QR') !== -1 ||
		(methodType.indexOf('wechatpay') !== -1 && methodType.indexOf('wechatpayWeb') === -1) ||
		methodType == "scheme"
	) {
		return true;
	}
	
	return false;
}

/**
 * Make a request to Adyen to get payment methods based on countryCode. Meant for AJAX storefront requests
 */
function getPaymentMethodsJSON() {
	var cart = app.getModel('Cart').get();
    if (Site.getCurrent().getCustomPreferenceValue("Adyen_directoryLookup")) {
    	var	getPaymentMethods = require('int_adyen_overlay/cartridge/scripts/getPaymentMethodsSHA256');
    	var json = JSON.stringify(getPaymentMethods.getMethods(cart.object, request.httpParameterMap.country.getStringValue()));
    }
    app.getView({
        hppJson: json || {}
    }).render('hppjson');
}

/**
 * Get configured terminals  
 */
function getTerminals() {
	var terminals = Site.getCurrent().getCustomPreferenceValue("Adyen_multi_terminals");
   	return terminals;
}

/**
 * Get orderdata for the Afterpay Payment method
 */
function afterpay() {
	var	readOpenInvoiceRequest = require('int_adyen_overlay/cartridge/scripts/readOpenInvoiceRequest');
   	var invoice = readOpenInvoiceRequest.getInvoiceParams(request.httpParameterMap);
   	var order = OrderMgr.getOrder(invoice.penInvoiceReference);
   	// show error if data mismach
   	if ((order.getBillingAddress().getPostalCode() !=  request.httpParameterMap.pc.toString())
   	 || (order.getBillingAddress().getPhone() !=  request.httpParameterMap.pn.toString())
   	 || (order.getCustomerNo() != request.httpParameterMap.cn.toString())
   	 || (order.getCustomerEmail() != request.httpParameterMap.ce.toString())
   	 || (invoice.openInvoiceAmount != Math.round(order.totalGrossPrice * 100)))
   	{
   		app.getView().render('afterpayerror');
   		return {};
   	}
   	
   	var	buildOpenInvoiceResponse = require('int_adyen_overlay/cartridge/scripts/buildOpenInvoiceResponse');
   	var invoiceResponse = buildOpenInvoiceResponse.getInvoiceResponse(order);
   	app.getView({OpenInvoiceResponse:invoiceResponse}).render('afterpay');
}


/**
 * Handle Refused payments
 */
function refusedPayment(order) {
    if (request.httpParameterMap.authResult.value == 'REFUSED') {
		var	adyenHppRefusedPayment = require('int_adyen_overlay/cartridge/scripts/adyenHppRefusedPayment.ds');
		Transaction.wrap(function () {
			adyenHppRefusedPayment.handle(request.httpParameterMap, order);
		});
    	
	}
	return '';
}


/**
 * Handle payments Cancelled on Adyen HPP
 */
function cancelledPayment(order) {
    if (request.httpParameterMap.authResult.value == 'CANCELLED') {
		var	adyenHppCancelledPayment = require('int_adyen_overlay/cartridge/scripts/adyenHppCancelledPayment');
		Transaction.wrap(function () {
			adyenHppCancelledPayment.handle(request.httpParameterMap, order);
		});
	}
	return '';
}


/**
 * Handle payments Pending on Adyen HPP
 */
function pendingPayment(order) {
	if (request.httpParameterMap.authResult.value == 'PENDING') {
		var	adyenHppPendingPayment = require('int_adyen_overlay/cartridge/scripts/adyenHppPendingPayment');
		Transaction.wrap(function () {
			adyenHppPendingPayment.handle(request.httpParameterMap, order);
		});
	}
	return '';
}


/**
 * Call the Adyen API to capture order payment
 */
function capture(args) {
	var order = args.Order;
	var orderNo = args.OrderNo;
	
	if (!order) {
		// Checking order data against values from parameters
		order = OrderMgr.getOrder(orderNo);
		if (!order || order.getBillingAddress().getPostalCode() !=  session.custom.pc.toString() 
			|| order.getBillingAddress().getPhone() !=  session.custom.pn.toString() 
			|| order.getCustomerNo() != session.custom.cn.toString() 
			|| order.getCustomerEmail() != session.custom.ce.toString()) {
			return {error: true};
		}
	}

	
	var	adyenCapture = require('int_adyen_overlay/cartridge/scripts/adyenCapture'), result;
    Transaction.wrap(function () {
		result = adyenCapture.capture(order);
	});
	
	if (result === PIPELET_ERROR) {
		return {error: true};
	}
	
    return {sucess: true};
}


/**
 * Call the Adyen API to cancel order payment
 */
function cancel() {
    var order = args.Order;
	var orderNo = args.OrderNo;
	
	if (!order) {
		// Checking order data against values from parameters
		order = OrderMgr.getOrder(orderNo);
		if (!order || order.getBillingAddress().getPostalCode() !=  session.custom.pc.toString() 
			|| order.getBillingAddress().getPhone() !=  session.custom.pn.toString() 
			|| order.getCustomerNo() != session.custom.cn.toString() 
			|| order.getCustomerEmail() != session.custom.ce.toString()) {
			return {error: true};
		}
	}

	
	var	adyenCancel = require('int_adyen_overlay/cartridge/scripts/adyenCancel'), result;
    Transaction.wrap(function () {
		result = adyenCancel.cancel(order);
	});
	
	if (result === PIPELET_ERROR) {
		return {error: true};
	}
	
    return {sucess: true};
}


/**
 * Call the Adyen API to cancel or refund order payment
 */
function cancelOrRefund() {
    var order = args.Order;
	var orderNo = args.OrderNo;
	
	if (!order) {
		// Checking order data against values from parameters
		order = OrderMgr.getOrder(orderNo);
		if (!order || order.getBillingAddress().getPostalCode() !=  session.custom.pc.toString() 
			|| order.getBillingAddress().getPhone() !=  session.custom.pn.toString() 
			|| order.getCustomerNo() != session.custom.cn.toString() 
			|| order.getCustomerEmail() != session.custom.ce.toString()) {
			return {error: true};
		}
	}

	
	var	adyenCapture = require('int_adyen_overlay/cartridge/scripts/adyenCapture'), result;
    Transaction.wrap(function () {
		result = adyenCapture.capture(order);
	});
	
	if (result === PIPELET_ERROR) {
		return {error: true};
	}
	
    return {sucess: true};
}


function redirect3ds2(result, token) {
	
	// SFRA CODE
//	var resultCode = req.querystring.resultCode;
//    var token3ds2 = req.querystring.token3ds2;
//
//    res.render('/threeds2/adyen3ds2', {
//        resultCode: resultCode,
//        token3ds2: token3ds2
//    });
	
	var threedsParams = {
			resultCode : request.httpParameterMap.get("resultCode").stringValue,
			token3ds2 : request.httpParameterMap.get("token3ds2").stringValue
	}
	
	// TODO: Decide how to handle params either thru query string params or passed into function
	
	if (request.httpParameterMap.get("resultCode").stringValue) {
		var resultCode = request.httpParameterMap.get("resultCode").stringValue;
	} else {
		var resultCode = result;
	}
	
	if (request.httpParameterMap.get("token3ds2").stringValue) {
		var token3ds2 = request.httpParameterMap.get("token3ds2").stringValue;
	} else {
		var token3ds2 = token;
	}
	
	
	app.getView({
    	resultCode : resultCode,
		token3ds2 : token3ds2,
        ContinueURL: URLUtils.https('Adyen-Authorize3DS2')
    }).render('/threeds2/adyen3ds2');
	 
	
	// TODO: need to find out how to pass thru the threedsParams
//    app.getView({
//    	resultCode : request.httpParameterMap.get("resultCode").stringValue,
//		token3ds2 : request.httpParameterMap.get("token3ds2").stringValue,
//        ContinueURL: URLUtils.https('Adyen-Authorize3DS2')
//    }).render('/threeds2/adyen3ds2');
}

/**
 * Make second call to /payments/details with IdentifyShopper or ChallengeShopper token
 * 
 * @returns rendering template or error
 */
function authorize3ds2() {
	// this is what triggered after the IdentifyShopper or ChallengeShopper component returns result
	var adyenCheckout = require('int_adyen_overlay/cartridge/scripts/adyenCheckout');
    var paymentInstrument;
    var order;

    if (session.custom.orderNo && session.custom.paymentMethod) {
        try {
            order = OrderMgr.getOrder(session.custom.orderNo);
            paymentInstrument = order.getPaymentInstruments(session.custom.paymentMethod)[0];
        } catch (e) {
            Logger.getLogger("Adyen").error("Unable to retrieve order data from session 3DS2.");
            Transaction.wrap(function () {
                OrderMgr.failOrder(order);
            });
            app.getController('COSummary').Start({
                PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
            });
            return {};
        }

        var details = {};
        
        // TODO: Need to find how to get these values
        // request.httpParameterMap.get("resultCode").stringValue;
        // request.httpParameterMap.get("fingerprintResult").stringValue;
        if (req.form.resultCode == "IdentifyShopper" && req.form.fingerprintResult) {
            details = {
                "threeds2.fingerprint": req.form.fingerprintResult
            }
        } else if (req.form.resultCode == "ChallengeShopper" && req.form.challengeResult) {
            details = {
                "threeds2.challengeResult": req.form.challengeResult
            }
        }
        else {
            Logger.getLogger("Adyen").error("paymentDetails 3DS2 not available");
            Transaction.wrap(function () {
                OrderMgr.failOrder(order);
            });
            app.getController('COSummary').Start({
                PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
            });
            return {};
        }

        var paymentDetailsRequest = {
            "paymentData": paymentInstrument.custom.adyenPaymentData,
            "details": details
        };

        var result = adyenCheckout.doPaymentDetailsCall(paymentDetailsRequest);
        if ((result.error || result.resultCode != 'Authorised') && result.resultCode != 'ChallengeShopper') {
            //Payment failed
            Transaction.wrap(function () {
                OrderMgr.failOrder(order);
                paymentInstrument.custom.adyenPaymentData = null;
            });
            app.getController('COSummary').Start({
                PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
            });
            return {};
        } else if (result.resultCode == 'ChallengeShopper') {
            //Redirect to ChallengeShopper
        	//res.redirect(URLUtils.url('Adyen-Adyen3DS2', 'resultCode', result.resultCode, 'token3ds2', result.authentication['threeds2.challengeToken']));
        	app.getController('Adyen').Adyen3DS2(result.resultCode, result.authentication['threeds2.challengeToken']);
        }

        //delete paymentData from requests
        Transaction.wrap(function () {
            paymentInstrument.custom.adyenPaymentData = null;
        });
       
        if ('pspReference' in result && !empty(result.pspReference)) {
            paymentInstrument.paymentTransaction.transactionID = result.pspReference;
            order.custom.Adyen_pspReference = result.pspReference;
        }
        if ('resultCode' in result && !empty(result.resultCode)) {
            paymentInstrument.paymentTransaction.custom.authCode = result.resultCode;
        }

        // Save full response to transaction custom attribute
        paymentInstrument.paymentTransaction.custom.Adyen_log = JSON.stringify(result);

        order.setPaymentStatus(dw.order.Order.PAYMENT_STATUS_PAID);
        order.setExportStatus(dw.order.Order.EXPORT_STATUS_READY);
        paymentInstrument.custom.adyenPaymentData = null;
        Transaction.commit();

        // TODO: COHelpers.sendConfirmationEmail(order, req.locale.id);
        OrderModel.submit(order);
        clearForms();
        app.getController('COSummary').ShowConfirmation(order);
        return {};
    }

    Logger.getLogger("Adyen").error("Session variables for 3DS2 do not exist");
    app.getController('COSummary').Start({
        PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
    });
    return {};
}


/**
 * Make second call to 3d verification system to complete authorization 
 * 
 * @returns rendering template or error
 */
function authorizeWithForm() {
	var order;
	var paymentInstrument;
	var	adyenResponse = session.custom.adyenResponse;

    if(session.custom.orderNo && session.custom.paymentMethod) {
        try {
            order = OrderMgr.getOrder(session.custom.orderNo);
            paymentInstrument = order.getPaymentInstruments(session.custom.paymentMethod)[0];
        } catch (e) {
            Logger.getLogger("Adyen").error("Unable to retrieve order data from session.");
            Transaction.wrap(function () {
                OrderMgr.failOrder(order);
            });
            app.getController('COSummary').Start({
                PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
            });
            return {};
        }

        clearCustomSessionFields();
        Transaction.begin();
        var adyenCheckout = require('int_adyen_overlay/cartridge/scripts/adyenCheckout');
        var jsonRequest = {
            "paymentData": paymentInstrument.custom.adyenPaymentData,
            "details": {
                "MD": adyenResponse.MD,
                "PaRes": adyenResponse.PaRes
            }
        };

        var result = adyenCheckout.doPaymentDetailsCall(jsonRequest);

        if (result.error || result.resultCode != 'Authorised') {
            Transaction.rollback();
            Transaction.wrap(function () {
                paymentInstrument.custom.adyenPaymentData = null;
                OrderMgr.failOrder(order);
            });
            app.getController('COSummary').Start({
                PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
            });
            return {};
        }
        if ('pspReference' in result && !empty(result.pspReference)) {
            paymentInstrument.paymentTransaction.transactionID = result.pspReference;
            order.custom.Adyen_pspReference = result.pspReference;
        }
        if ('resultCode' in result && !empty(result.resultCode)) {
            paymentInstrument.paymentTransaction.custom.authCode = result.resultCode;
        }

        // Save full response to transaction custom attribute
        paymentInstrument.paymentTransaction.custom.Adyen_log = JSON.stringify(result);

        order.setPaymentStatus(dw.order.Order.PAYMENT_STATUS_PAID);
        order.setExportStatus(dw.order.Order.EXPORT_STATUS_READY);
        paymentInstrument.custom.adyenPaymentData = null;
        Transaction.commit();

        OrderModel.submit(order);
        clearForms();
        app.getController('COSummary').ShowConfirmation(order);
        return {};
    }
    else {
        Logger.getLogger("Adyen").error("Session variable does not exists");
        app.getController('COSummary').Start({
            PlaceOrderError: new Status(Status.ERROR, 'confirm.error.declined', '')
        });
        return {};
    }
}

/**
 * Close IFrame where was 3d secure form
 * 
 * @returns template
 */
function closeIFrame() {
	var adyenResponse = {
			MD : request.httpParameterMap.get("MD").stringValue,
			PaRes : request.httpParameterMap.get("PaRes").stringValue
	}
	session.custom.adyenResponse = adyenResponse;
    app.getView({
        ContinueURL: URLUtils.https('Adyen-AuthorizeWithForm')
    }).render('adyenpaymentredirect');
}

/**
 * Clear system session data 
 */
function clearForms() {
    // Clears all forms used in the checkout process.
    session.forms.singleshipping.clearFormElement();
    session.forms.multishipping.clearFormElement();
    session.forms.billing.clearFormElement();
    
    clearCustomSessionFields();
}

/**
 * Clear custom session data 
 */
function clearCustomSessionFields() {
	// Clears all fields used in the 3d secure payment.
    session.custom.adyenResponse = null;
    session.custom.paymentMethod = null;
    session.custom.orderNo = null;
    session.custom.adyenBrandCode = null;
    session.custom.adyenIssuerID = null;
}

function getExternalPlatformVersion(){
	return EXTERNAL_PLATFORM_VERSION;
}

exports.Authorize3DS2 = guard.ensure(['https', 'post'], authorize3ds2);

exports.Redirect3DS2 = guard.ensure(['https', 'post'], redirect3ds2);

exports.AuthorizeWithForm = guard.ensure(['https', 'post'], authorizeWithForm);

exports.CloseIFrame = guard.ensure(['https', 'post'], closeIFrame);

exports.Notify = guard.ensure(['post'], notify);

exports.Redirect = redirect;

exports.Afterpay = guard.ensure(['get'], afterpay);

exports.ShowConfirmation = guard.httpsGet(showConfirmation);

exports.OrderConfirm = guard.httpsGet(orderConfirm);

exports.GetPaymentMethods = getPaymentMethods;

exports.GetPaymentMethodsJSON = guard.ensure(['get'], getPaymentMethodsJSON);

exports.GetTerminals = getTerminals;

exports.RefusedPayment = refusedPayment;

exports.CancelledPayment = cancelledPayment;

exports.PendingPayment = pendingPayment;

exports.Capture = capture;

exports.Cancel = cancel;

exports.CancelOrRefund = cancelOrRefund;

exports.getExternalPlatformVersion = getExternalPlatformVersion();