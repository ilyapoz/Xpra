/*
 * Copyright (c) 2013-2016 Antoine Martin <antoine@devloop.org.uk>
 * Copyright (c) 2016 David Brushinski <dbrushinski@spikes.com>
 * Copyright (c) 2014 Joshua Higgins <josh@kxes.net>
 * Copyright (c) 2015-2016 Spikes, Inc.
 * Licensed under MPL 2.0
 *
 * xpra client
 *
 * requires:
 *	Protocol.js
 *	Window.js
 *	Keycodes.js
 */

"use strict";

var XPRA_CLIENT_FORCE_NO_WORKER = false;

function XpraClient(container) {
	// state
	var me = this;
	this.host = null;
	this.port = null;
	this.ssl = null;
	this.debug = false;
	this.sharing = false;
	this.remote_logging = true;
	this.server_remote_logging = false;
	// some client stuff
	this.capabilities = {};
	this.RGB_FORMATS = ["RGBX", "RGBA"];
	this.supported_encodings = ["jpeg", "png", "rgb", "rgb32"];	//"h264", "vp8+webm", "h264+mp4", "mpeg4+mp4"];
	this.enabled_encodings = [];
	this.normal_fullscreen_mode = false;
	this.start_new_session = null;
	this.username = "";
	this.disconnect_reason = null;
	// audio
	this.audio_enabled = false;
	this.audio_mediasource_enabled = MediaSourceUtil.getMediaSourceClass()!=null;
	this.audio_aurora_enabled = AV!=null && AV.Decoder!=null && AV.Player.fromXpraSource!=null;
	this.audio_codecs = {};
	this.audio_framework = null;
	this.audio_aurora_ctx = null;
	this.audio_codec = null;
	this.audio_context = Utilities.getAudioContext();
	// encryption
	this.encryption = false;
	this.encryption_key = null;
	this.cipher_in_caps = null;
	this.cipher_out_caps = null;
	// authentication
	this.insecure = false;
	this.authentication_key = null;
	// hello
	this.HELLO_TIMEOUT = 10000;
	this.hello_timer = null;
	// ping
	this.PING_TIMEOUT = 60000;
	this.ping_timer = null;
	this.last_ping_echoed_time = 0;
	this.server_ok = false;
    //packet handling
    this.queue_draw_packets = true;
    this.dQ = [];
    this.dQ_interval_id = null;
    this.process_interval = 4;

	// the container div is the "screen" on the HTML page where we
	// are able to draw our windows in.
	this.container = document.getElementById(container);
	if(!this.container) {
		throw "invalid container element";
	}
	// assign callback for window resize event
	if (window.jQuery) {
		jQuery(window).resize(jQuery.debounce(250, function (e) {
			me._screen_resized(e, me);
		}));
	}

	// a list of our windows
	this.id_to_window = {};
	// basic window management
	this.topwindow = null;
	this.topindex = 0;
	this.focus = -1;
	// the protocol
	this.protocol = null;
}


XpraClient.prototype.send_log = function(level, args) {
	if(this.remote_logging && this.server_remote_logging) {
		try {
			var sargs = [];
			for(var i = 0; i < args.length; i++) {
				sargs.push(String(args[i]));
			}
			this.protocol.send(["logging", level, sargs]);
		} catch (e) {
			console.error("remote logging failed: "+e);
			for(var i = 0; i < args.length; i++) {
				console.log(" argument", i, typeof args[i], ":", "'"+args[i]+"'");
			}
		}
	}
}
XpraClient.prototype.error = function() {
	//logging.ERROR = 40
	this.send_log(40, arguments);
	console.error.apply(console, arguments);
}
XpraClient.prototype.warn = function() {
	//logging.WARN = 30
	this.send_log(30, arguments);
	console.log.apply(console, arguments);
}
XpraClient.prototype.log = function() {
	//logging.INFO = 20
	this.send_log(20, arguments);
	console.log.apply(console, arguments);
}


XpraClient.prototype.init = function() {
	this.init_audio();
	this.init_packet_handlers();
	this.init_clipboard();
	this.init_keyboard();
}

XpraClient.prototype.init_audio = function() {
	if(this.debug) {
		console.debug("init_audio() enabled="+this.audio_enabled+", mediasource enabled="+this.audio_mediasource_enabled+", aurora enabled="+this.audio_aurora_enabled);
	}
	if(!this.audio_enabled) {
		return;
	}
	var mediasource_codecs = {};
	if(this.audio_mediasource_enabled) {
		mediasource_codecs = MediaSourceUtil.getMediaSourceAudioCodecs();
		for (var codec_option in mediasource_codecs) {
			this.audio_codecs[codec_option] = mediasource_codecs[codec_option];
		}
	}
	var aurora_codecs = {};
	if(this.audio_aurora_enabled) {
		aurora_codecs = MediaSourceUtil.getAuroraAudioCodecs();
		for (var codec_option in aurora_codecs) {
			if(codec_option in this.audio_codecs) {
				//we already have native MediaSource support!
				continue;
			}
			this.audio_codecs[codec_option] = aurora_codecs[codec_option];
		}
	}
	if(!this.audio_codecs) {
		this.audio_codec = null;
		this.audio_enabled = false;
		this.warn("no valid audio codecs found");
		return;
	}
	if(!(this.audio_codec in this.audio_codecs)) {
		if(this.audio_codec) {
			this.warn("invalid audio codec: "+this.audio_codec);
		}
		this.audio_codec = MediaSourceUtil.getDefaultAudioCodec(this.audio_codecs);
		if(this.audio_codec) {
			if(this.audio_codec in mediasource_codecs) {
				this.audio_framework = "mediasource";
			}
			else {
				this.audio_framework = "aurora";
			}
			this.log("using "+this.audio_framework+" audio codec: "+this.audio_codec);
		}
		else {
			this.warn("no valid audio codec found");
			this.audio_enabled = false;
		}
	}
	else {
		this.log("using "+this.audio_framework+" audio codec: "+this.audio_codec);
	}
	this.log("audio codecs: ", Object.keys(this.audio_codecs));
}

XpraClient.prototype.init_clipboard = function() {
	// the "clipboard"
	this.clipboard_buffer = "";
	this.clipboard_targets = ["UTF8_STRING", "TEXT", "STRING", "text/plain"];
}

XpraClient.prototype.init_keyboard = function() {
	var me = this;
	this.keyboard_layout = null;
	// modifier keys:
	this.caps_lock = null;
	this.num_lock = true;
	this.num_lock_mod = null;
	this.alt_modifier = null;
	this.meta_modifier = null;
	// assign the keypress callbacks
	// if we detect jQuery, use that to assign them instead
	// to allow multiple clients on the same page
	if (window.jQuery) {
		jQuery(document).keydown(function (e) {
			e.preventDefault();
			me._keyb_onkeydown(e, me);
		});
		jQuery(document).keyup(function (e) {
			e.preventDefault();
			me._keyb_onkeyup(e, me);
		});
		jQuery(document).keypress(function (e) {
			e.preventDefault();
			me._keyb_onkeypress(e, me);
		});
	} else {
		document.onkeydown = function (e) {
			me._keyb_onkeydown(e, me);
		};
		document.onkeyup = function (e) {
			me._keyb_onkeyup(e, me);
		};
		document.onkeypress = function (e) {
			me._keyb_onkeypress(e, me);
		};
	}
}


XpraClient.prototype.init_packet_handlers = function() {
	// the client holds a list of packet handlers
	this.packet_handlers = {
		'open': this._process_open,
		'close': this._process_close,
		'error': this._process_error,
		'disconnect': this._process_disconnect,
		'challenge': this._process_challenge,
		'startup-complete': this._process_startup_complete,
		'hello': this._process_hello,
		'ping': this._process_ping,
		'ping_echo': this._process_ping_echo,
		'new-window': this._process_new_window,
		'new-override-redirect': this._process_new_override_redirect,
		'window-metadata': this._process_window_metadata,
		'lost-window': this._process_lost_window,
		'raise-window': this._process_raise_window,
		'window-icon': this._process_window_icon,
		'window-resized': this._process_window_resized,
		'window-move-resize': this._process_window_move_resize,
		'configure-override-redirect': this._process_configure_override_redirect,
		'desktop_size': this._process_desktop_size,
		'draw': this._process_draw,
		'cursor': this._process_cursor,
		'bell': this._process_bell,
		'notify_show' : this._process_notify_show,
		'notify_close' : this._process_notify_close,
		'sound-data': this._process_sound_data,
		'clipboard-token': this._process_clipboard_token,
		'set-clipboard-enabled': this._process_set_clipboard_enabled,
		'clipboard-request': this._process_clipboard_request,
		'send-file': this._process_send_file,
	};
}


XpraClient.prototype.callback_close = function(reason) {
	if (reason === undefined) {
		reason = "unknown reason";
	}
	console.log("connection closed: "+reason);
}

XpraClient.prototype.connect = function(host, port, ssl) {
	// open the web socket, started it in a worker if available
	console.log("connecting to xpra server " + host + ":" + port + " with ssl: " + ssl);
	this.host = host;
	this.port = port;
	this.ssl = ssl;
	// check we have enough information for encryption
	if(this.encryption) {
		if((!this.encryption_key) || (this.encryption_key == "")) {
			this.callback_close("no key specified for encryption");
			return;
		}
	}
	// detect websocket in webworker support and degrade gracefully
	if(window.Worker) {
		console.log("we have webworker support");
		// spawn worker that checks for a websocket
		var me = this;
		var worker = new Worker('js/lib/wsworker_check.js');
		worker.addEventListener('message', function(e) {
			var data = e.data;
			switch (data['result']) {
			case true:
				// yey, we can use websocket in worker!
				console.log("we can use websocket in webworker");
				me._do_connect(true);
				break;
			case false:
				console.log("we can't use websocket in webworker, won't use webworkers");
				me._do_connect(false);
				break;
			default:
				console.log("client got unknown message from worker");
				me._do_connect(false);
			};
		}, false);
		// ask the worker to check for websocket support, when we receive a reply
		// through the eventlistener above, _do_connect() will finish the job
		worker.postMessage({'cmd': 'check'});
	} else {
		// no webworker support
		console.log("no webworker support at all.")
	}
}

XpraClient.prototype._do_connect = function(with_worker) {
	if(with_worker && !(XPRA_CLIENT_FORCE_NO_WORKER)) {
		this.protocol = new XpraProtocolWorkerHost();
	} else {
		this.protocol = new XpraProtocol();
	}
	// set protocol to deliver packets to our packet router
	this.protocol.set_packet_handler(this._route_packet, this);
	// make uri
	var uri = "ws://";
	if (this.ssl)
		uri = "wss://";
	uri += this.host;
	uri += ":" + this.port;
	// do open
	this.protocol.open(uri);
	// wait timeout seconds for a hello, then bomb
	var me = this;
	this.hello_timer = setTimeout(function () {
		me.disconnect_reason = "Did not receive hello before timeout reached, not an Xpra server?";
		me.close();
	}, this.HELLO_TIMEOUT);
}

XpraClient.prototype.close = function() {
	// close all windows
	// close protocol
	this.protocol.close();
}

XpraClient.prototype.enable_encoding = function(encoding) {
	// add an encoding to our hello.encodings list
	console.log("enable",encoding);
	this.enabled_encodings.push(encoding);
}

XpraClient.prototype.disable_encoding = function(encoding) {
	// remove an encoding from our hello.encodings.core list
	// as if we don't support it
	console.log("disable",encoding);
	var index = this.supported_encodings.indexOf(encoding);
	if(index > -1) {
		this.supported_encodings.splice(index, 1);
	}
}

XpraClient.prototype._route_packet = function(packet, ctx) {
	// ctx refers to `this` because we came through a callback
	var packet_type = "";
	var fn = "";
	packet_type = packet[0];
	if (ctx.debug)
		console.log("received a " + packet_type + " packet");
	fn = ctx.packet_handlers[packet_type];
	if (fn==undefined) {
		console.error("no packet handler for "+packet_type+"!");
		console.log(packet);
	} else {
		fn(packet, ctx);
	}
}

XpraClient.prototype._screen_resized = function(event, ctx) {
	// send the desktop_size packet so server knows we changed size
	var newsize = this._get_desktop_size();
	var packet = ["desktop_size", newsize[0], newsize[1], this._get_screen_sizes()];
	ctx.protocol.send(packet);
	// call the screen_resized function on all open windows
	for (var i in ctx.id_to_window) {
		var iwin = ctx.id_to_window[i];
		iwin.screen_resized();
	}
}

XpraClient.prototype.handle_paste = function(text) {
	// set our clipboard buffer
	this.clipboard_buffer = text;
	// send token
	var packet = ["clipboard-token", "CLIPBOARD"];
	this.protocol.send(packet);
	// tell user to paste in remote application
	// alert("Paste acknowledged. Please paste in remote application.");
}

XpraClient.prototype._keyb_get_modifiers = function(event) {
	/**
	 * Returns the modifiers set for the current event.
	 * We get the list of modifiers using "get_event_modifiers"
	 * then translate "alt" and "meta" into their keymap name.
	 * (usually "mod1")
	 */
	//convert generic modifiers "meta" and "alt" into their x11 name:
	var modifiers = get_event_modifiers(event);
	//FIXME: look them up!
	var alt = "mod1";
	var meta = "mod1";
	var index = modifiers.indexOf("alt");
	if (index>=0)
		modifiers[index] = alt;
	index = modifiers.indexOf("meta");
	if (index>=0)
		modifiers[index] = meta;
	//show("get_modifiers() modifiers="+modifiers.toSource());
	return modifiers;
}

XpraClient.prototype._keyb_process = function(pressed, event) {
	/**
	 * Process a key event: key pressed or key released.
	 * Figure out the keycode, keyname, modifiers, etc
	 * And send the event to the server.
	 */
	// MSIE hack
	if (window.event)
		event = window.event;
	//show("processKeyEvent("+pressed+", "+event+") keyCode="+event.keyCode+", charCode="+event.charCode+", which="+event.which);

	var keyname = "";
	var keycode = 0;
	if (event.which)
		keycode = event.which;
	else
		keycode = event.keyCode;
	if (keycode==144 && pressed)
		this.num_lock = !this.num_lock;
	if (keycode in CHARCODE_TO_NAME)
		keyname = CHARCODE_TO_NAME[keycode];
	if (this.num_lock && keycode>=96 && keycode<106)
		keyname = "KP_"+(keycode-96);
	var DOM_KEY_LOCATION_RIGHT = 2;
	if (keyname.match("_L$") && event.location==DOM_KEY_LOCATION_RIGHT)
		keyname = keyname.replace("_L", "_R")

	var modifiers = this._keyb_get_modifiers(event);
	if (this.caps_lock)
		modifiers.push("lock");
	if (this.num_lock && this.num_lock_mod)
		modifiers.push(this.num_lock_mod);
	var keyval = keycode;
	var str = String.fromCharCode(event.which);
	var group = 0;

	var shift = modifiers.indexOf("shift")>=0;
	if ((this.caps_lock && shift) || (!this.caps_lock && !shift))
		str = str.toLowerCase();

	if (this.topwindow != null) {
		//show("win="+win.toSource()+", keycode="+keycode+", modifiers=["+modifiers+"], str="+str);
		var packet = ["key-action", this.topwindow, keyname, pressed, modifiers, keyval, str, keycode, group];
		this.protocol.send(packet);
	}
}

XpraClient.prototype._keyb_onkeydown = function(event, ctx) {
	ctx._keyb_process(true, event);
	return false;
};
XpraClient.prototype._keyb_onkeyup = function(event, ctx) {
	ctx._keyb_process(false, event);
	return false;
};

XpraClient.prototype._keyb_onkeypress = function(event, ctx) {
	/**
	 * This function is only used for figuring out the caps_lock state!
	 * onkeyup and onkeydown give us the raw keycode,
	 * whereas here we get the keycode in lowercase/uppercase depending
	 * on the caps_lock and shift state, which allows us to figure
	 * out caps_lock state since we have shift state.
	 */
	var keycode = 0;
	if (event.which)
		keycode = event.which;
	else
		keycode = event.keyCode;
	var modifiers = ctx._keyb_get_modifiers(event);

	/* PITA: this only works for keypress event... */
	ctx.caps_lock = false;
	var shift = modifiers.indexOf("shift")>=0;
	if (keycode>=97 && keycode<=122 && shift)
		ctx.caps_lock = true;
	else if (keycode>=65 && keycode<=90 && !shift)
		ctx.caps_lock = true;
	//show("caps_lock="+caps_lock);
	return false;
};

XpraClient.prototype._get_keyboard_layout = function() {
	if (this.keyboard_layout)
		return this.keyboard_layout;
	return Utilities.getKeyboardLayout();
}

XpraClient.prototype._get_keycodes = function() {
	//keycodes.append((nn(keyval), nn(name), nn(keycode), nn(group), nn(level)))
	var keycodes = [];
	var kc;
	for(var keycode in CHARCODE_TO_NAME) {
		kc = parseInt(keycode);
		keycodes.push([kc, CHARCODE_TO_NAME[keycode], kc, 0, 0]);
	}
	//show("keycodes="+keycodes.toSource());
	return keycodes;
}

XpraClient.prototype._get_desktop_size = function() {
	return [this.container.clientWidth, this.container.clientHeight];
}

XpraClient.prototype._get_DPI = function() {
	"use strict";
	var dpi_div = document.getElementById("dpi");
	if (dpi_div != undefined) {
		//show("dpiX="+dpi_div.offsetWidth+", dpiY="+dpi_div.offsetHeight);
		if (dpi_div.offsetWidth>0 && dpi_div.offsetHeight>0)
			return Math.round((dpi_div.offsetWidth + dpi_div.offsetHeight) / 2.0);
	}
	//alternative:
	if ('deviceXDPI' in screen)
		return (screen.systemXDPI + screen.systemYDPI) / 2;
	//default:
	return 96;
}

XpraClient.prototype._get_screen_sizes = function() {
	var dpi = this._get_DPI();
	var screen_size = this._get_desktop_size();
	var wmm = Math.round(screen_size[0]*25.4/dpi);
	var hmm = Math.round(screen_size[1]*25.4/dpi);
	var monitor = ["Canvas", 0, 0, screen_size[0], screen_size[1], wmm, hmm];
	var screen = ["HTML", screen_size[0], screen_size[1],
				wmm, hmm,
				[monitor],
				0, 0, screen_size[0], screen_size[1]
			];
	//just a single screen:
	return [screen];
}

XpraClient.prototype._get_encodings = function() {
	if(this.enabled_encodings.length == 0) {
		// return all supported encodings
		console.log("return all encodings: ", this.supported_encodings);
		return this.supported_encodings;
	} else {
		console.log("return just enabled encodings: ", this.enabled_encodings);
		return this.enabled_encodings;
	}
}

XpraClient.prototype._update_capabilities = function(appendobj) {
	for (var attr in appendobj) {
		this.capabilities[attr] = appendobj[attr];
	}
}

XpraClient.prototype._check_server_echo = function(ping_sent_time) {
	var last = this.server_ok;
	this.server_ok = this.last_ping_echoed_time >= ping_sent_time;
	//console.log("check_server_echo", this.server_ok, "last", last, "last_time", this.last_ping_echoed_time, "this_this", ping_sent_time);
	if(last != this.server_ok) {
		if(!this.server_ok) {
			console.log("server connection is not responding, drawing spinners...");
		} else {
			console.log("server connection is OK");
		}
		for (var win in this.id_to_window) {
			this.id_to_window[win].set_spinner(this.server_ok);
		}
	}
}

XpraClient.prototype._check_echo_timeout = function(ping_time) {
	if(this.last_ping_echoed_time < ping_time) {
		// no point in telling the server here...
		this.callback_close("server ping timeout, waited "+ this.PING_TIMEOUT +"ms without a response");
	}
}

XpraClient.prototype._send_ping = function() {
	var me = this;
	var now_ms = Date.now();
	this.protocol.send(["ping", now_ms]);
	// add timeout to wait for ping timout
	setTimeout(function () {
		me._check_echo_timeout(now_ms);
	}, this.PING_TIMEOUT);
	// add timeout to detect temporary ping miss for spinners
	var wait = 2000;
	setTimeout(function () {
		me._check_server_echo(now_ms);
	}, wait);
}

XpraClient.prototype._send_hello = function(challenge_response, client_salt) {
	// make the base hello
	this._make_hello_base();
	// handle a challenge if we need to
	if((this.authentication_key) && (!challenge_response)) {
		// tell the server we expect a challenge (this is a partial hello)
		this.capabilities["challenge"] = true;
		console.log("sending partial hello");
	} else {
		console.log("sending hello");
		// finish the hello
		this._make_hello();
	}
	if(challenge_response) {
		this._update_capabilities({
			"challenge_response": challenge_response
		});
		if(client_salt) {
			this._update_capabilities({
				"challenge_client_salt" : client_salt
			});
		}
	}
	console.log("hello capabilities: "+this.capabilities);
	// verify:
	for (var key in this.capabilities) {
	    var value = this.capabilities[key];
	    if(key==null) {
	    	throw "invalid null key in hello packet data";
	    }
	    else if(value==null) {
	    	throw "invalid null value for key "+key+" in hello packet data";
	    }
	}
	// send the packet
	this.protocol.send(["hello", this.capabilities]);
}

XpraClient.prototype._make_hello_base = function() {
	this.capabilities = {};
	this._update_capabilities({
		// version and platform
		"version"					: Utilities.VERSION,
		"platform"					: Utilities.getPlatformName(),
		"platform.name"				: Utilities.getPlatformName(),
		"platform.processor"		: Utilities.getPlatformProcessor(),
		"platform.platform"			: navigator.appVersion,
		"namespace"			 		: true,
		"share"						: this.sharing,
		"client_type"				: "HTML5",
		"encoding.generic" 			: true,
		"username" 					: this.username,
		"uuid"						: Utilities.getHexUUID(),
		"argv" 						: [window.location.href],
		"digest" 					: ["hmac", "xor"],
		"salt-digest"					: ["hmac", "xor"],
		//compression bits:
		"zlib"						: true,
		"lzo"						: false,
		"compression_level"	 		: 1,
		// packet encoders
		"rencode" 					: false,
		"bencode"					: true,
		"yaml"						: false,
	});
	var LZ4 = require('lz4');
	if(LZ4) {
		this._update_capabilities({
			"lz4"						: true,
			"lz4.js.version"			: LZ4.version,
			"encoding.rgb_lz4"			: true,
		});
	}

	if(this.encryption) {
		this.cipher_in_caps = {
			"cipher"					: this.encryption,
			"cipher.iv"					: Utilities.getHexUUID().slice(0, 16),
			"cipher.key_salt"			: Utilities.getHexUUID()+Utilities.getHexUUID(),
			"cipher.key_stretch_iterations"	: 1000,
			"cipher.padding.options"	: ["PKCS#7"],
		};
		this._update_capabilities(this.cipher_in_caps);
		// copy over the encryption caps with the key for recieved data
		this.protocol.set_cipher_in(this.cipher_in_caps, this.encryption_key);
	}
	if(this.start_new_session) {
		this._update_capabilities({"start-new-session" : this.start_new_session});
	}
}

XpraClient.prototype._make_hello = function() {
	this._update_capabilities({
		"auto_refresh_delay"		: 500,
		"randr_notify"				: true,
		"sound.server_driven"		: true,
		"server-window-resize"		: true,
		"notify-startup-complete"	: true,
		"generic-rgb-encodings"		: true,
		"window.raise"				: true,
		"encodings"					: this._get_encodings(),
		"raw_window_icons"			: true,
		"encoding.icons.max_size"	: [30, 30],
		"encodings.core"			: this.supported_encodings,
		"encodings.rgb_formats"	 	: this.RGB_FORMATS,
		"encodings.window-icon"		: ["png"],
		"encodings.cursor"			: ["png"],
		"encoding.generic"			: true,
		"encoding.transparency"		: true,
		"encoding.client_options"	: true,
		"encoding.csc_atoms"		: true,
		"encoding.scrolling"		: true,
		//video stuff:
		"encoding.video_scaling"	: true,
		"encoding.full_csc_modes"	: {
			"h264" 		: ["YUV420P"],
			"mpeg4+mp4"	: ["YUV420P"],
			"h264+mp4"	: ["YUV420P"],
			"vp8+webm"	: ["YUV420P"],
		},
		"encoding.x264.YUV420P.profile"		: "baseline",
		"encoding.h264.YUV420P.profile"		: "baseline",
		"encoding.h264.YUV420P.level"		: "2.1",
		"encoding.h264.cabac"				: false,
		"encoding.h264.deblocking-filter"	: false,
		"encoding.h264+mp4.YUV420P.profile"	: "main",
		"encoding.h264+mp4.YUV420P.level"	: "3.0",
		//prefer native video in mp4/webm container to broadway plain h264:
		"encoding.h264.score-delta"			: -20,
		"encoding.h264+mp4.score-delta"		: 50,
		"encoding.mpeg4+mp4.score-delta"	: 50,
		"encoding.vp8+webm.score-delta"		: 50,

		"sound.receive"				: true,
		"sound.send"				: false,
		"sound.decoders"			: Object.keys(this.audio_codecs),
		// encoding stuff
		"encoding.rgb24zlib"		: true,
		"encoding.rgb_zlib"			: true,
		"windows"					: true,
		//partial support:
		"keyboard"					: true,
		"xkbmap_layout"				: this._get_keyboard_layout(),
		"xkbmap_keycodes"			: this._get_keycodes(),
		"xkbmap_print"				: "",
		"xkbmap_query"				: "",
		"desktop_size"				: this._get_desktop_size(),
		"screen_sizes"				: this._get_screen_sizes(),
		"dpi"						: this._get_DPI(),
		//not handled yet, but we will:
		"clipboard_enabled"			: true,
		"clipboard.want_targets"	: true,
		"clipboard.selections"		: ["CLIPBOARD"],
		"notifications"				: true,
		"cursors"					: true,
		"bell"						: true,
		"system_tray"				: true,
		//we cannot handle this (GTK only):
		"named_cursors"				: false,
		// printing
		"file-transfer" 			: true,
		"printing" 					: true,
		"file-size-limit"				: 10,
	});
}

/*
 * Window callbacks
 */

XpraClient.prototype._new_window = function(wid, x, y, w, h, metadata, override_redirect, client_properties) {
	// each window needs their own DIV that contains a canvas
	var mydiv = document.createElement("div");
	mydiv.id = String(wid);
	var mycanvas = document.createElement("canvas");
	mydiv.appendChild(mycanvas);
	document.body.appendChild(mydiv);
	// set initial sizes
	mycanvas.width = w;
	mycanvas.height = h;
	// create the XpraWindow object to own the new div
	var win = new XpraWindow(this, mycanvas, wid, x, y, w, h,
		metadata,
		override_redirect,
		client_properties,
		this._window_geometry_changed,
		this._window_mouse_move,
		this._window_mouse_click,
		this._window_set_focus,
		this._window_closed
		);
	win.debug = this.debug;
	this.id_to_window[wid] = win;
	if (!override_redirect) {
		if(this.normal_fullscreen_mode) {
			if(win.windowtype == "NORMAL") {
				win.undecorate();
				win.set_maximized(true);
			}
		}
		var geom = win.get_internal_geometry();
		this.protocol.send(["map-window", wid, geom.x, geom.y, geom.w, geom.h, this._get_client_properties(win)]);
		this._window_set_focus(win);
	}
}

XpraClient.prototype._new_window_common = function(packet, override_redirect) {
	var wid, x, y, w, h, metadata;
	wid = packet[1];
	x = packet[2];
	y = packet[3];
	w = packet[4];
	h = packet[5];
	metadata = packet[6];
	if (wid in this.id_to_window)
		throw "we already have a window " + wid;
	if (w<=0 || h<=0) {
		this.error("window dimensions are wrong: "+w+"x"+h);
		w, h = 1, 1;
	}
	var client_properties = {}
	if (packet.length>=8)
		client_properties = packet[7];
	this._new_window(wid, x, y, w, h, metadata, override_redirect, client_properties)
}

XpraClient.prototype._window_closed = function(win) {
	win.client.protocol.send(["close-window", win.wid]);
}

XpraClient.prototype._get_client_properties = function(win) {
	var cp = win.client_properties;
	cp["encodings.rgb_formats"] = this.RGB_FORMATS;
	return cp;
}

XpraClient.prototype._window_geometry_changed = function(win) {
	// window callbacks are called from the XpraWindow function context
	// so use win.client instead of `this` to refer to the client
	var geom = win.get_internal_geometry();
	var wid = win.wid;

	if (!win.override_redirect) {
		win.client._window_set_focus(win);
	}
	win.client.protocol.send(["configure-window", wid, geom.x, geom.y, geom.w, geom.h, win.client._get_client_properties(win)]);
}

XpraClient.prototype._window_mouse_move = function(win, x, y, modifiers, buttons) {
	var wid = win.wid;
	win.client.protocol.send(["pointer-position", wid, [x, y], modifiers, buttons]);
}

XpraClient.prototype._window_mouse_click = function(win, button, pressed, x, y, modifiers, buttons) {
	var wid = win.wid;
	// dont call set focus unless the focus has actually changed
	if(win.client.focus != wid) {
		win.client._window_set_focus(win);
	}
	win.client.protocol.send(["button-action", wid, button, pressed, [x, y], modifiers, buttons]);
}

XpraClient.prototype._window_set_focus = function(win) {
	// don't send focus packet for override_redirect windows!
	if(!win.override_redirect) {
		var wid = win.wid;
		win.client.focus = wid;
		win.client.topwindow = wid;
		win.client.protocol.send(["focus", wid, []]);
		//set the focused flag on all windows:
		for (var i in win.client.id_to_window) {
			var iwin = win.client.id_to_window[i];
			iwin.focused = (i==wid);
			iwin.updateFocus();
		}
	}
}

XpraClient.prototype._window_send_damage_sequence = function(wid, packet_sequence, width, height, decode_time) {
	// this function requires wid as arugment because it may be called
	// without a valid client side window
	this.protocol.send(["damage-sequence", packet_sequence, wid, width, height, decode_time]);
}


XpraClient.prototype._sound_start_receiving = function() {
	try {
		if(this.audio_framework=="mediasource") {
			this._sound_start_mediasource();
		}
		else {
			this._sound_start_aurora();
		}
	}
	catch(e) {
		this.error('error starting audio player: '+e);
	}
}


XpraClient.prototype._send_sound_start = function() {
	this.log("audio: requesting "+this.audio_codec+" stream from the server");
	this.protocol.send(["sound-control", "start", this.audio_codec]);
}

XpraClient.prototype._sound_start_aurora = function() {
	this.audio_buffers_count = 0;
	this.audio_aurora_ctx = AV.Player.fromXpraSource();
	this.audio_aurora_ctx.play();
	this._send_sound_start();
}

XpraClient.prototype._sound_start_mediasource = function() {
	var me = this;

	function audio_error(event) {
		if(me.audio) {
			me.error(event+" error: "+me.audio.error);
			if(me.audio.error) {
				me.error(MediaSourceConstants.ERROR_CODE[me.audio.error.code]);
			}
		}
		else {
			me.error(event+" error");
		}
		me._close_audio();
	}

	//Create a MediaSource:
	this.media_source = MediaSourceUtil.getMediaSource();
	if(this.debug) {
		MediaSourceUtil.addMediaSourceEventDebugListeners(this.media_source, "audio");
	}
	this.media_source.addEventListener('error', 	function(e) {audio_error("audio source"); });

	//Create an <audio> element:
	this.audio = document.createElement("audio");
	this.audio.setAttribute('autoplay', true);
	if(this.debug) {
		MediaSourceUtil.addMediaElementEventDebugListeners(this.audio, "audio");
	}
	this.audio.addEventListener('play', 			function() { console.log("audio play!"); });
	this.audio.addEventListener('error', 			function() { audio_error("audio"); });
	document.body.appendChild(this.audio);

	//attach the MediaSource to the <audio> element:
	this.audio.src = window.URL.createObjectURL(this.media_source);
	this.audio_buffers = []
	this.audio_buffers_count = 0;
	this.audio_source_ready = false;
	console.log("audio waiting for source open event on "+this.media_source);
	this.media_source.addEventListener('sourceopen', function() {
		me.log("audio media source open");
		if (me.audio_source_ready) {
			me.warn("ignoring: source already open");
			return;
		}
		//ie: codec_string = "audio/mp3";
		var codec_string = MediaSourceConstants.CODEC_STRING[me.audio_codec];
		if(codec_string==null) {
			me.error("invalid codec '"+me.audio_codec+"'");
			me._close_audio();
			return;
		}
		me.log("using audio codec string for "+me.audio_codec+": "+codec_string);

		//Create a SourceBuffer:
		var asb = null;
		try {
			asb = me.media_source.addSourceBuffer(codec_string);
		} catch (e) {
			me.error("audio setup error for '"+codec_string+"':", e);
			me._close_audio();
			return;
		}
		me.audio_source_buffer = asb;
		asb.mode = "sequence";
		if (this.debug) {
			MediaSourceUtil.addSourceBufferEventDebugListeners(asb, "audio");
		}
		asb.addEventListener('error', 				function(e) { audio_error("audio buffer"); });
		me.audio_source_ready = true;
		me._send_sound_start();
	});
}

XpraClient.prototype._close_audio = function() {
	this.protocol.send(["sound-control", "stop"]);
	if(this.audio_framework=="mediasource") {
		this._close_audio_mediasource();
	}
	else {
		this._close_audio_aurora();
	}
}

XpraClient.prototype._close_audio_aurora = function() {
	if(this.audio_aurora_ctx) {
		//this.audio_aurora_ctx.close();
		this.audio_aurora_ctx = null;
	}
	this.audio_buffers_count = 0;
}

XpraClient.prototype._close_audio_mediasource = function() {
	this.log("close_audio: audio_source_buffer="+this.audio_source_buffer+", media_source="+this.media_source+", video="+this.audio);
	this.audio_source_ready = false;
	if(this.audio) {
		this.protocol.send(["sound-control", "stop"]);
		if(this.media_source) {
			try {
				if(this.audio_source_buffer) {
					this.media_source.removeSourceBuffer(this.audio_source_buffer);
					this.audio_source_buffer = null;
				}
				if(this.media_source.readyState=="open") {
					this.media_source.endOfStream();
				}
			} catch(e) {
				this.warn("audio media source EOS error:", e);
			}
			this.media_source = null;
		}
		this.audio.src = "";
		this.audio.load();
		document.body.removeChild(this.audio);
		this.audio = null;
	}
}


/*
 * packet processing functions start here
 */

XpraClient.prototype._process_open = function(packet, ctx) {
	// call the send_hello function
	ctx._send_hello();
}

XpraClient.prototype._process_error = function(packet, ctx) {
	// terminate the worker
	ctx.protocol.terminate();
	// call the client's close callback
	ctx.callback_close(ctx.disconnect_reason);
	// clear the reason
	ctx.disconnect_reason = null;
	console.log("error: "+packet[1]);
}

XpraClient.prototype._process_close = function(packet, ctx) {
	ctx._close_audio();
	// terminate the worker
	ctx.protocol.terminate();
	// call the client's close callback
	ctx.callback_close(ctx.disconnect_reason);
	// clear the reason
	ctx.disconnect_reason = null;
	console.log("close: "+packet[1]);
}

XpraClient.prototype._process_disconnect = function(packet, ctx) {
	// clear the timer if we are waiting for a hello
	if(ctx.hello_timer) {
		clearTimeout(ctx.hello_timer);
		ctx.hello_timer = null;
	}
	// stop the ping timer
	if(ctx.ping_timer) {
		clearTimeout(ctx.ping_timer);
		ctx.ping_timer = null;
	}
	// save the disconnect reason
	ctx.disconnect_reason = packet[1];
	// post a close request to the protocol
	// this will eventually raise a close packet processed above
	ctx.close();
}

XpraClient.prototype._process_startup_complete = function(packet, ctx) {
	ctx.log("startup complete");
}

XpraClient.prototype._process_hello = function(packet, ctx) {
	//show("process_hello("+packet+")");
	// clear hello timer
	if(ctx.hello_timer) {
		clearTimeout(ctx.hello_timer);
		ctx.hello_timer = null;
	}
	var hello = packet[1];
	ctx.server_remote_logging = hello["remote-logging.multi-line"];
	if(ctx.server_remote_logging && ctx.remote_logging) {
		//hook remote logging:
		Utilities.log = function() { ctx.log.apply(ctx, arguments); };
		Utilities.warn = function() { ctx.warn.apply(ctx, arguments); };
		Utilities.error = function() { ctx.error.apply(ctx, arguments); };
	}

	// check for server encryption caps update
	if(ctx.encryption) {
		ctx.cipher_out_caps = {
			"cipher"					: hello['cipher'],
			"cipher.iv"					: hello['cipher.iv'],
			"cipher.key_salt"			: hello['cipher.key_salt'],
			"cipher.key_stretch_iterations"	: hello['cipher.key_stretch_iterations'],
		};
		ctx.protocol.set_cipher_out(ctx.cipher_out_caps, ctx.encryption_key);
	}
	// find the modifier to use for Num_Lock
	var modifier_keycodes = hello['modifier_keycodes']
	if (modifier_keycodes) {
		for (var modifier in modifier_keycodes) {
			if (modifier_keycodes.hasOwnProperty(modifier)) {
				var mappings = modifier_keycodes[modifier];
				for (var keycode in mappings) {
					var keys = mappings[keycode];
					for (var index in keys) {
						var key=keys[index];
						if (key=="Num_Lock") {
							ctx.num_lock_mod = modifier;
						}
					}
				}
			}
		}
	}

	var version = hello["version"];
	try {
		var vparts = version.split(".");
		var vno = [];
		for (var i=0; i<vparts.length;i++) {
			vno[i] = parseInt(vparts[i]);
		}
		if (vno[0]<=0 && vno[1]<10) {
			ctx.callback_close("unsupported version: " + version);
			ctx.close();
			return;
		}
	}
	catch (e) {
		ctx.callback_close("error parsing version number '" + version + "'");
		ctx.close();
		return;
	}
	ctx.log("got hello: server version "+version+" accepted our connection");
	//figure out "alt" and "meta" keys:
	if ("modifier_keycodes" in hello) {
		var modifier_keycodes = hello["modifier_keycodes"];
		for (var mod in modifier_keycodes) {
			//show("modifier_keycode["+mod+"]="+modifier_keycodes[mod].toSource());
			var keys = modifier_keycodes[mod];
			for (var i=0; i<keys.length; i++) {
				var key = keys[i];
				//the first value is usually the integer keycode,
				//the second one is the actual key name,
				//doesn't hurt to test both:
				for (var j=0; j<key.length; j++) {
					if ("Alt_L"==key[j])
						ctx.alt_modifier = mod;
					if ("Meta_L"==key[j])
						ctx.meta_modifier = mod;
				}
			}
		}
	}
	//show("alt="+alt_modifier+", meta="+meta_modifier);
	// stuff that must be done after hello
	if(ctx.audio_enabled) {
		if(!(hello["sound.send"])) {
			ctx.error("server does not support speaker forwarding");
			ctx.audio_enabled = false;
		}
		else {
			ctx.server_audio_codecs = hello["sound.encoders"];
			if(!ctx.server_audio_codecs) {
				ctx.error("audio codecs missing on the server");
				ctx.audio_enabled = false;
			}
			else {
				ctx.log("audio codecs supported by the server:", ctx.server_audio_codecs);
				if(ctx.server_audio_codecs.indexOf(ctx.audio_codec)<0) {
					ctx.warn("audio codec "+ctx.audio_codec+" is not supported by the server");
					ctx.audio_codec = null;
					//find the best one we can use:
					for(var i = 0; i < MediaSourceConstants.PREFERRED_CODEC_ORDER.length; i++) {
						var codec = MediaSourceConstants.PREFERRED_CODEC_ORDER[i];
						if ((codec in ctx.audio_codecs) && (ctx.server_audio_codecs.indexOf(codec)>=0)){
							if (MediaSourceUtil.getAuroraAudioCodecs()[codec]) {
								ctx.audio_framework = "aurora";
							}
							else {
								ctx.audio_framework = "mediasource";
							}
							ctx.audio_codec = codec;
							ctx.log("using", ctx.audio_framework, "audio codec", codec);
							break;
						}
					}
					if(!ctx.audio_codec) {
						ctx.warn("audio codec: no matches found");
						ctx.audio_enabled = false;
					}
				}
			}
			if (ctx.audio_enabled) {
				ctx._sound_start_receiving();
			}
		}
	}
	if (hello["printing"]!=0) {
		// send our printer definition
		var printers = {
			"HTML5 client": {
				"printer-info": "Print to PDF in client browser",
				"printer-make-and-model": "HTML5 client version",
				"mimetypes": ["application/pdf"]
			}
		};
		ctx.protocol.send(["printers", printers]);
	}
	// start sending our own pings
	ctx._send_ping();
	ctx.ping_timer = setInterval(function () {
		ctx._send_ping();
		return true;
	}, 10000);
}

XpraClient.prototype._process_challenge = function(packet, ctx) {
	console.log("process challenge");
	if ((!ctx.authentication_key) || (ctx.authentication_key == "")) {
		ctx.callback_close("No password specified for authentication challenge");
		return;
	}
	if(ctx.encryption) {
		if(packet.length >=3) {
			ctx.cipher_out_caps = packet[2];
			ctx.protocol.set_cipher_out(ctx.cipher_out_caps, ctx.encryption_key);
		} else {
			ctx.callback_close("challenge does not contain encryption details to use for the response");
			return;
		}
	}
	var digest = packet[3];
	var server_salt = packet[1];
	var client_salt = null;
    var salt_digest = packet[4] || "xor";
    var l = server_salt.length;
    if (salt_digest=="xor") {
    	//don't use xor over unencrypted connections unless explicitly allowed:
    	if (digest == "xor") {
    		if((!ctx.ssl) && (!ctx.encryption) && (!ctx.insecure) && (ctx.host!="localhost") && (ctx.host!="127.0.0.1")) {
    			ctx.callback_close("server requested digest xor, cowardly refusing to use it without encryption with "+ctx.host);
    			return;
    		}
    	}
    	if (l<16 || l>256) {
    		ctx.callback_close("invalid server salt length for xor digest:"+l);
    		return;
    	}
    }
    else {
        //other digest, 32 random bytes is enough:
    	l = 32;
    }
	client_salt = Utilities.getSalt(l);
	console.log("challenge using salt digest", salt_digest);
	var salt = ctx._gendigest(salt_digest, client_salt, server_salt);
	if (!salt) {
		this.callback_close("server requested an unsupported salt digest " + salt_digest);
		return;
	}
	console.log("challenge using digest", digest);
	var challenge_response = ctx._gendigest(digest, ctx.authentication_key, salt);
	if (challenge_response) {
		ctx._send_hello(challenge_response, client_salt);
	}
	else {
		this.callback_close("server requested an unsupported digest " + digest);
	}
}

XpraClient.prototype._gendigest = function(digest, password, salt) {
	if (digest.startsWith("hmac")) {
		var hash="md5";
		if (digest.indexOf("+")>0) {
			hash = digest.split("+")[1];
		}
		console.log("hmac using hash", hash);
		var hmac = forge.hmac.create();
		hmac.start(hash, password);
		hmac.update(salt);
		return hmac.digest().toHex();
	} else if (digest == "xor") {
		var trimmed_salt = salt.slice(0, password.length);
		return Utilities.xorString(trimmed_salt, password);
	} else {
		return null;
	}
}

XpraClient.prototype._process_ping = function(packet, ctx) {
	var echotime = packet[1];
	var l1=0, l2=0, l3=0;
	ctx.protocol.send(["ping_echo", echotime, l1, l2, l3, 0]);
}

XpraClient.prototype._process_ping_echo = function(packet, ctx) {
	ctx.last_ping_echoed_time = packet[1];
	// make sure server goes OK immediately instead of waiting for next timeout
	ctx._check_server_echo(0);
}

XpraClient.prototype._process_new_window = function(packet, ctx) {
	ctx._new_window_common(packet, false);
}

XpraClient.prototype._process_new_override_redirect = function(packet, ctx) {
	ctx._new_window_common(packet, true);
}

XpraClient.prototype._process_window_metadata = function(packet, ctx) {
	var wid = packet[1],
		metadata = packet[2],
		win = ctx.id_to_window[wid];
	if (win!=null) {
		win.update_metadata(metadata);
	}
}

XpraClient.prototype._process_lost_window = function(packet, ctx) {
	var wid = packet[1];
	var win = ctx.id_to_window[wid];
	try {
		delete ctx.id_to_window[wid];
	}
	catch (e) {}
	if (win!=null) {
		win.destroy();
	}
}

XpraClient.prototype._process_raise_window = function(packet, ctx) {
	var wid = packet[1];
	var win = ctx.id_to_window[wid];
	if (win!=null) {
		ctx._window_set_focus(win);
	}
}

XpraClient.prototype._process_window_resized = function(packet, ctx) {
	var wid = packet[1];
	var width = packet[2];
	var height = packet[3];
	var win = ctx.id_to_window[wid];
	if (win!=null) {
		win.resize(width, height);
	}
}

XpraClient.prototype._process_window_move_resize = function(packet, ctx) {
	var wid = packet[1];
	var x = packet[2];
	var y = packet[3];
	var width = packet[4];
	var height = packet[5];
	var win = ctx.id_to_window[wid];
	if (win!=null) {
		win.move_resize(x, y, width, height);
	}
}

XpraClient.prototype._process_configure_override_redirect = function(packet, ctx) {
	var wid = packet[1];
	var x = packet[2];
	var y = packet[3];
	var width = packet[4];
	var height = packet[5];
	var win = ctx.id_to_window[wid];
	if (win!=null) {
		win.move_resize(x, y, width, height);
	}
}

XpraClient.prototype._process_desktop_size = function(packet, ctx) {
	//root_w, root_h, max_w, max_h = packet[1:5]
	//we don't use this yet,
	//we could use this to clamp the windows to a certain area
}

XpraClient.prototype._process_bell = function(packet, ctx) {
	var percent = packet[3];
	var pitch = packet[4];
	var duration = packet[5];
	if (ctx.audio_context!=null) {
		var oscillator = ctx.audio_context.createOscillator();
		var gainNode = ctx.audio_context.createGain();
		oscillator.connect(gainNode);
		gainNode.connect(ctx.audio_context.destination);
		gainNode.gain.value = percent;
		oscillator.frequency.value = pitch;
		oscillator.start();
		setTimeout(function(){oscillator.stop()}, duration);
	}
	else {
		var snd = new Audio("data:audio/wav;base64,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qJrx4KOQjahZxWbcZgztj2c49nKmkId44S71j0c8eV9yDK6uPRzx5X18eDvjvQ6yKo9ZSS6l//8elePK/Lf//IInrOF/FvDoADYAGBMGb7FtErm5MXMlmPAJQVgWta7Zx2go+8xJ0UiCb8LHHdftWyLJE0QIAIsI+UbXu67dZMjmgDGCGl1H+vpF4NSDckSIkk7Vd+sxEhBQMRU8j/12UIRhzSaUdQ+rQU5kGeFxm+hb1oh6pWWmv3uvmReDl0UnvtapVaIzo1jZbf/pD6ElLqSX+rUmOQNpJFa/r+sa4e/pBlAABoAAAAA3CUgShLdGIxsY7AUABPRrgCABdDuQ5GC7DqPQCgbbJUAoRSUj+NIEig0YfyWUho1VBBBA//uQZB4ABZx5zfMakeAAAAmwAAAAF5F3P0w9GtAAACfAAAAAwLhMDmAYWMgVEG1U0FIGCBgXBXAtfMH10000EEEEEECUBYln03TTTdNBDZopopYvrTTdNa325mImNg3TTPV9q3pmY0xoO6bv3r00y+IDGid/9aaaZTGMuj9mpu9Mpio1dXrr5HERTZSmqU36A3CumzN/9Robv/Xx4v9ijkSRSNLQhAWumap82WRSBUqXStV/YcS+XVLnSS+WLDroqArFkMEsAS+eWmrUzrO0oEmE40RlMZ5+ODIkAyKAGUwZ3mVKmcamcJnMW26MRPgUw6j+LkhyHGVGYjSUUKNpuJUQoOIAyDvEyG8S5yfK6dhZc0Tx1KI/gviKL6qvvFs1+bWtaz58uUNnryq6kt5RzOCkPWlVqVX2a/EEBUdU1KrXLf40GoiiFXK///qpoiDXrOgqDR38JB0bw7SoL+ZB9o1RCkQjQ2CBYZKd/+VJxZRRZlqSkKiws0WFxUyCwsKiMy7hUVFhIaCrNQsKkTIsLivwKKigsj8XYlwt/WKi2N4d//uQRCSAAjURNIHpMZBGYiaQPSYyAAABLAAAAAAAACWAAAAApUF/Mg+0aohSIRobBAsMlO//Kk4soosy1JSFRYWaLC4qZBYWFRGZdwqKiwkNBVmoWFSJkWFxX4FFRQWR+LsS4W/rFRb/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////VEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU291bmRib3kuZGUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAwNGh0dHA6Ly93d3cuc291bmRib3kuZGUAAAAAAAAAACU=");
		snd.play();
	}
	return;
}

XpraClient.prototype._process_notify_show = function(packet, ctx) {
	//TODO: add UI switch to disable notifications
	var dbus_id = packet[1];
	var nid = packet[2];
	var app_name = packet[3];
	var replaces_nid = packet[4];
	var app_icon = packet[5];
	var summary = packet[6];
	var body = packet[7];
	var expire_timeout = packet[8];
	if(window.closeNotification) {
		if (replaces_nid>0) {
			window.closeNotification(replaces_nid);
		}
		window.closeNotification(nid);
	}
	if(window.doNotification) {
		window.doNotification("info", nid, summary, body, expire_timeout);
	}
}

XpraClient.prototype._process_notify_close = function(packet, ctx) {
	nid = packet[1];
	if(window.closeNotification) {
		window.closeNotification(nid);
	}
}


XpraClient.prototype.reset_cursor = function(packet, ctx) {
	for (var wid in ctx.id_to_window) {
		var window = ctx.id_to_window[wid];
		window.reset_cursor();
	}
	return;
}

XpraClient.prototype._process_cursor = function(packet, ctx) {
	if (packet.length==2) {
		ctx.reset_cursor(packet, ctx);
		return;
	}
	if (packet.length<9) {
		ctx.reset_cursor();
		return;
	}
	//we require a png encoded cursor packet:
	var encoding = packet[1];
	if (encoding!="png") {
		ctx.warn("invalid cursor encoding: "+encoding);
		return;
	}
	var w = packet[4];
	var h = packet[5];
	var img_data = packet[9];
	for (var wid in ctx.id_to_window) {
		var window = ctx.id_to_window[wid];
		window.set_cursor(encoding, w, h, img_data);
	}
}

XpraClient.prototype._process_window_icon = function(packet, ctx) {
	var wid = packet[1];
	var w = packet[2];
	var h = packet[3];
	var encoding = packet[4];
	var img_data = packet[5];
	if(ctx.debug) {
		console.debug("window-icon: "+encoding+" size "+w+"x"+h);
	}
	var win = ctx.id_to_window[wid];
	if (win) {
		win.update_icon(w, h, encoding, img_data);
	}
}

XpraClient.prototype._process_draw = function(packet, ctx) {
    if(ctx.queue_draw_packets){
        if (ctx.dQ_interval_id === null) {
            ctx.dQ_interval_id = setInterval(function(){
                ctx._process_draw_queue(null, ctx);
            }, ctx.process_interval);
        }

        ctx.dQ[ctx.dQ.length] = packet;
    } else {
        ctx._process_draw_queue(packet, ctx);
    }
}

XpraClient.prototype._process_draw_queue = function(packet, ctx){
    if(!packet && ctx.queue_draw_packets){
        packet = ctx.dQ.shift();
        if(!packet){
            return;
        }
    }
    if(!packet){
        //no valid draw packet, likely handle errors for that here
        return;
    }

    var start = new Date().getTime(),
		wid = packet[1],
		x = packet[2],
		y = packet[3],
		width = packet[4],
		height = packet[5],
		coding = packet[6],
		data = packet[7],
		packet_sequence = packet[8],
		rowstride = packet[9],
		options = {};
	if (packet.length>10)
		options = packet[10];
	var win = ctx.id_to_window[wid];
	var decode_time = -1;
	if (!win) {
		if(ctx.debug) {
			console.debug('cannot paint, window not found:', wid);
		}
		ctx._window_send_damage_sequence(wid, packet_sequence, width, height, -1, "window not found");
		return;
	}
	try {
		win.paint(x, y,
			width, height,
			coding, data, packet_sequence, rowstride, options,
			function (ctx) {
				var flush = options["flush"] || 0;
				if(flush==0) {
					// request that drawing to screen takes place at next available opportunity if possible
					if(requestAnimationFrame) {
						requestAnimationFrame(function() {
							win.draw();
						});
					} else {
						// requestAnimationFrame is not available, draw immediately
						win.draw();
					}
				}
				decode_time = new Date().getTime() - start;
				if(ctx.debug) {
					console.debug("decode time for ", coding, " sequence ", packet_sequence, ": ", decode_time);
				}
				ctx._window_send_damage_sequence(wid, packet_sequence, width, height, decode_time, "");
			}
		);
	}
	catch(e) {
		ctx.error('error painting', coding, e);
		ctx._window_send_damage_sequence(wid, packet_sequence, width, height, -1, String(e));
	}
}

XpraClient.prototype._process_sound_data = function(packet, ctx) {
	if(packet[1]!=ctx.audio_codec) {
		ctx.error("invalid audio codec '"+packet[1]+"' (expected "+ctx.audio_codec+"), stopping audio stream");
		ctx._close_audio();
		return;
	}
	if(packet[3]["end-of-stream"] == 1) {
		ctx.log("server sent end-of-stream");
		ctx._close_audio();
		return;
	}
	try {
		if(ctx.audio_framework=="mediasource") {
			ctx._process_sound_data_mediasource(packet);
		}
		else {
			ctx._process_sound_data_aurora(packet);
		}
	}
	catch(e) {
		ctx.error('error processing audio data:', e);
		ctx._close_audio();
	}
}

XpraClient.prototype._process_sound_data_aurora = function(packet) {
	if(packet[3]["start-of-stream"] == 1) {
		this.log("audio start of "+this.audio_framework+" "+this.audio_codec+" stream");
		return;
	}
	var buf = packet[2];
	if(this.debug) {
		console.debug("audio aurora context: adding "+buf.length+" bytes of "+this.audio_codec+" data");
	}
	if(!this.audio_aurora_ctx) {
		this.warn("audio aurora context is closed already, dropping sound buffer");
		return;
	}
	this.audio_buffers_count += 1;
	this.audio_aurora_ctx.asset.source._on_data(buf);
}

XpraClient.prototype._process_sound_data_mediasource = function(packet) {
	if(!this.audio) {
		return;
	}
	if(packet[3]["start-of-stream"] == 1) {
		this.log("audio start of "+this.audio_framework+" "+this.audio_codec+" stream");
		this.audio.play();
		return;
	}
	try {
		if (this.debug) {
			console.debug("sound-data: "+packet[1]+", "+packet[2].length+" bytes, state="+MediaSourceConstants.READY_STATE[this.audio.readyState]+", network state="+MediaSourceConstants.NETWORK_STATE[this.audio.networkState]);
			console.debug("audio paused="+this.audio.paused+", queue size="+this.audio_buffers.length+", source ready="+this.audio_source_ready+", source buffer updating="+this.audio_source_buffer.updating);
		}
		var MAX_BUFFERS = 250;
		if(this.audio_buffers.length>=MAX_BUFFERS) {
			this.warn("audio queue overflowing: "+this.audio_buffers.length+", stopping");
			this._close_audio();
			return;
		}
		var buf = packet[2];
		this.audio_buffers.push(buf);
		var asb = this.audio_source_buffer;
		var ab = this.audio_buffers;
		//not needed for all codecs / browsers!
		var MIN_START_BUFFERS = 4;
		if(ab.length >= MIN_START_BUFFERS || this.audio_buffers_count>0){
			if(asb && !asb.updating) {
				var buffers = ab.splice(0, 200);
				var buffer = [].concat.apply([], buffers);
				this.audio_buffers_count += 1;
				asb.appendBuffer(new Uint8Array(buffer).buffer);
			}
		}
	}
	catch(e) {
		this.error("audio failed:", e);
		this._close_audio();
	}
}

XpraClient.prototype._process_clipboard_token = function(packet, ctx) {
	// only accept some clipboard types
	if(ctx.clipboard_targets.indexOf(packet[3])>=0) {
		// we should probably update our clipboard buffer
		ctx.clipboard_buffer = packet[7];
		// prompt user
		prompt("Text was placed on the remote clipboard:", packet[7]);
	}
}

XpraClient.prototype._process_set_clipboard_enabled = function(packet, ctx) {
	this.log("server set clipboard state to "+packet[1]+" reason was: "+packet[2]);
}

XpraClient.prototype._process_clipboard_request = function(packet, ctx) {
	var request_id = packet[1],
		selection = packet[2],
		target = packet[3];

	if(ctx.clipboard_buffer == "") {
		packet = ["clipboard-contents-none", request_id, selection];
	} else {
		var packet = ["clipboard-contents", request_id, selection, "UTF8_STRING", 8, "bytes", ctx.clipboard_buffer];
	}

	ctx.protocol.send(packet);
}

XpraClient.prototype._process_send_file = function(packet, ctx) {
	var mimetype = packet[2];
	var printit = packet[3];
	var datasize = packet[5];
	var data = packet[6];

	if (!printit) {
		ctx.warn("Received non printed file data");
	}
	else if(mimetype != "application/pdf") {
		ctx.warn("Received unsupported print data mimetype: "+mimetype);
	} else {
		// check the data size for file
		if(data.length != datasize) {
			ctx.warn("send-file: invalid data size, received", data.length, "bytes, expected", datasize);
		} else {
			ctx.log("got some data to print");
			var b64data = btoa(uintToString(data));
			window.open(
					'data:application/pdf;base64,'+b64data,
					'_blank'
			);
		}
	}
}
