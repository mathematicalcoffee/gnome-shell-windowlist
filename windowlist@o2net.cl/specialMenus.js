//vim: expandtab shiftwidth=4 tabstop=8 softtabstop=4 encoding=utf-8 textwidth=99
/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

// Some special subclasses of popupMenu
// such that the menu can be opened via a
// particular button only, or via hovering


const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Overview = imports.ui.overview;
const Params = imports.misc.params;
const PopupMenu = imports.ui.popupMenu;
const Shell = imports.gi.Shell;
const St = imports.gi.St;
const Tweener = imports.ui.tweener;

const Extension = imports.ui.extensionSystem.extensions['windowlist@o2net.cl'];
const SpecialButtons = Extension.specialButtons;

const HOVER_MENU_TIMEOUT = 1000;
const THUMBNAIL_DEFAULT_SIZE = Math.max(150, Main.layoutManager.primaryMonitor.width / 10);
/* see if Wnck can be found (if not, skip 'always on top' and 
 * 'always on visible workspace')
 */
var Wnck;
try {
    Wnck = imports.gi.Wnck;
} catch (err) {
    Wnck = false;
    log("gir for Wnck not found; skipping 'Always on top' and 'Always on visible workspace'");
}

// Laziness
Meta.MaximizeFlags.BOTH = Meta.MaximizeFlags.HORIZONTAL | Meta.MaximizeFlags.VERTICAL;
// Use the Mutter translations for the window functions.
// We have to remove the underscores (keyboard accelerators) after.
const Gettext = imports.gettext;
const M_ = Gettext.domain('mutter').gettext;
/* For convenience: a WindowOptions namespace to hold the window function information */
const WindowOptions = {
    /* the following expect `win` to be a Meta.Window */
    MINIMIZE: {
        label: M_("Mi_nimize"),
        symbol: '_',
        action: function (win) {
            win.minimize();
        }
    },

    MAXIMIZE: {
        label: M_("Ma_ximize"),
        symbol: '\u2610',
        toggleOff: 'RESTORE',
        isToggled: function (win) {
            return (win.get_maximized() === Meta.MaximizeFlags.BOTH);
        },
        action: function (win) {
            win.maximize(Meta.MaximizeFlags.BOTH);
        }
    },

    CLOSE_WINDOW: {
        label: M_("_Close"),
        symbol: 'X',
        action: function (win) {
            win.delete(global.get_current_time());
        }
    },

    MOVE: {
        label: M_("_Move"),
        symbol: '+',
        action: function (win) {
            Mainloop.idle_add(Lang.bind(this, function () {
                win.raise();
                let pointer = Gdk.Display.get_default().get_device_manager().get_client_pointer(),
                    [scr,,] = pointer.get_position(),
                    rect    = win.get_outer_rect(),
                    x       = rect.x + rect.width/2,
                    y       = rect.y + rect.height/2;
                pointer.warp(scr, x, y);
                global.display.begin_grab_op(global.screen, win,
                    Meta.GrabOp.MOVING, false, true, 1, 0, global.get_current_time(),
                    x, y);
                return false;
            }));
        }
    },

    RESIZE: {
        label: M_("_Resize"),
        symbol: '\u21f2',
        action: function (win) {
            Mainloop.idle_add(Lang.bind(this, function () {
                win.raise();
                let pointer = Gdk.Display.get_default().get_device_manager().get_client_pointer(),
                    [scr,,] = pointer.get_position(),
                    rect    = win.get_outer_rect(),
                    x       = rect.x + rect.width,
                    y       = rect.y + rect.height;
                pointer.warp(scr, x, y);
                global.display.begin_grab_op(global.screen, win,
                    Meta.GrabOp.RESIZING_SE, false, true, 1, 0, global.get_current_time(),
                    x, y);
                return false;
            }));
        }
    },

    /* the following expect `win` to be a Wnck.Window */
    ALWAYS_ON_TOP: {
        label: M_("Always on _Top"),
        symbol: '\u25b2',
        toggleOff: 'NOT_ALWAYS_ON_TOP',
        isToggled: function (win) {
            return win.is_above();
        },
        metaIsToggled: function (win) {
            return win.above;
        },
        action: function (win) {
            win.make_above();
        }
    },

    ALWAYS_ON_VISIBLE_WORKSPACE: {
        label: M_("Always on Visible Workspace"),
        symbol: '\u2693',
        toggleOff: 'ALWAYS_ON_THIS_WORKSPACE',
        isToggled: function (win) {
            return win.is_pinned();
        },
        metaIsToggled: function (win) {
            return win.is_on_all_workspaces();
        },
        action: function (win) {
            win.pin();
        }
    },

    // dummy functions
    NOT_ALWAYS_ON_TOP: {
        label: M_("Always on _Top"),
        symbol: '\u25b2',
        action: function (win) {
            win.unmake_above();
        }
    },

    ALWAYS_ON_THIS_WORKSPACE: {
        label: M_("Always on Visible Workspace"),
        symbol: '\u2693',
        action: function (win) {
            win.unpin();
        }
    },

    RESTORE: {
        label: M_("Unma_ximize"),
        symbol: '\u2752',
        // \u29c9 is two interlinked squares. It's quite tall though.
        // \u25f3 white square with upper right quadrant
        // \u2752 upper right shadowed white square
        action: function (win) {
            win.unmaximize(Meta.MaximizeFlags.BOTH);
        }
    }
};
const WnckOptions = ['ALWAYS_ON_TOP', 'ALWAYS_ON_VISIBLE_WORKSPACE'];

// remove underscores:
for (let dummy in WindowOptions) {
    if (WindowOptions.hasOwnProperty(dummy)) {
        WindowOptions[dummy].label = WindowOptions[dummy].label.replace(/_/g, '');
    }
}

function RightClickPopupMenu() {
    this._init.apply(this, arguments);
}

RightClickPopupMenu.prototype = {
    __proto__: PopupMenu.PopupMenu.prototype,

    _init: function(actor, params) {
        // openOnButton: which button opens the menu
        params = Params.parse(params, { openOnButton: 3 });

        PopupMenu.PopupMenu.prototype._init.call(this, actor, 0, St.Side.TOP);

        this.openOnButton = params.openOnButton;
        this._parentActor = actor;
        this._parentActor.connect('button-release-event', Lang.bind(this, this._onParentActorButtonRelease));

        this.actor.hide();
        Main.uiGroup.add_actor(this.actor);
    },

    _onParentActorButtonRelease: function(actor, event) {
        let buttonMask = Clutter.ModifierType['BUTTON' + this.openOnButton + '_MASK'];
        if (Shell.get_event_state(event) & buttonMask) {
            this.toggle();
        }
    }
};


function HoverMenuController() {
    this._init.apply(this, arguments);
}

HoverMenuController.prototype = {
    _init: function(actor, menu, params) {
        // reactive: should the menu stay open if your mouse is above the menu
        // clickShouldImpede: if you click actor, should the menu be prevented from opening
        // clickShouldClose: if you click actor, should the menu close
        params = Params.parse(params, { reactive: true,
                                        clickShouldImpede: true,
                                        clickShouldClose: true });

        this._parentActor = actor;
        this._parentMenu = menu;

        this._parentActor.reactive = true;
        this._parentActor.connect('enter-event', Lang.bind(this, this._onEnter));
        this._parentActor.connect('leave-event', Lang.bind(this, this._onLeave));

        // If we're reactive, it means that we can move our mouse to the popup
        // menu and interact with it.  It shouldn't close while we're interacting
        // with it.
        if (params.reactive) {
            this._parentMenu.actor.connect('enter-event', Lang.bind(this, this._onParentMenuEnter));
            this._parentMenu.actor.connect('leave-event', Lang.bind(this, this._onParentMenuLeave));
        }

        if (params.clickShouldImpede || params.clickShouldClose) {
            this.clickShouldImpede = params.clickShouldImpede;
            this.clickShouldClose = params.clickShouldClose;
            this._parentActor.connect('button-press-event', Lang.bind(this, this._onButtonPress));
        }
    },

    _onButtonPress: function() {
        if (this.clickShouldImpede) {
            this.shouldOpen = false;
        }
        if (this.clickShouldClose) {
            if (!this.impedeClose) {
                this.shouldClose = true;
            }
            this.close();
        }
    },

    _onParentMenuEnter: function() {
        this.shouldClose = false;
    },

    _onParentMenuLeave: function() {
        this.shouldClose = true;

        Mainloop.timeout_add(HOVER_MENU_TIMEOUT, Lang.bind(this, this.close));
    },

    _onEnter: function() {
        if (!this.impedeOpen) {
            this.shouldOpen = true;
        }
        this.shouldClose = false;

        Mainloop.timeout_add(HOVER_MENU_TIMEOUT, Lang.bind(this, this.open));
    },

    _onLeave: function() {
        if (!this.impedeClose) {
            this.shouldClose = true;
        }
        this.shouldOpen = false;

        Mainloop.timeout_add(HOVER_MENU_TIMEOUT, Lang.bind(this, this.close));
    },

    open: function() {
        if (this.shouldOpen && !this._parentMenu.isOpen) {
            this._parentMenu.open(true);
        }
    },

    close: function() {
        if (this.shouldClose) {
            this._parentMenu.close(true);
        }
    },

    enable: function() {
        this.impedeOpen = false;
    },

    disable: function() {
        this.impedeOpen = true;
    }
};

function HoverMenu() {
    this._init.apply(this, arguments);
}

HoverMenu.prototype = {
    __proto__: PopupMenu.PopupMenu.prototype,

    _init: function(actor, params) {
        PopupMenu.PopupMenu.prototype._init.call(this, actor, 0, St.Side.TOP);

        params = Params.parse(params, { reactive: true });

        this._parentActor = actor;

        this.actor.hide();

        if (params.reactive) {
            Main.layoutManager.addChrome(this.actor);
        } else {
            Main.uiGroup.add_actor(this.actor);
        }
    }
};

function AppThumbnailHoverMenu() {
    this._init.apply(this, arguments);
}

AppThumbnailHoverMenu.prototype = {
    __proto__: HoverMenu.prototype,

    _init: function(actor, metaWindow, app) {
        HoverMenu.prototype._init.call(this, actor, { reactive: true });

        this.metaWindow = metaWindow;
        this.app = app;

        this.appSwitcherItem = new PopupMenuAppSwitcherItem(this.metaWindow, this.app);
        this.addMenuItem(this.appSwitcherItem);
    },

    open: function(animate) {
        // Refresh all the thumbnails, etc when the menu opens.  These cannot
        // be created when the menu is initalized because a lot of the clutter window surfaces
        // have not been created yet...
        this.appSwitcherItem._refresh();
        PopupMenu.PopupMenu.prototype.open.call(this, animate);
    },

    setMetaWindow: function(metaWindow) {
        this.metaWindow = metaWindow;
        this.appSwitcherItem.setMetaWindow(metaWindow);
    }
}


function PopupMenuThumbnailItem() {
    this._init.apply(this, arguments);
}

PopupMenuThumbnailItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function (image, params) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, params);

        this.image = image;
        this.addActor(this.image);
    }
};

// display a list of app thumbnails and allow
// bringing any app to focus by clicking on its thumbnail
function PopupMenuAppSwitcherItem() {
    this._init.apply(this, arguments);
}

PopupMenuAppSwitcherItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function (metaWindow, app, params) {
        params = Params.parse(params, { hover: false });
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this, params);

        this.metaWindow = metaWindow;
        this.app = app;

        this.appContainer = new St.BoxLayout({ style_class: 'app-window-switcher',
                                               reactive: true,
                                               track_hover: true,
                                               can_focus: true,
                                               vertical: false });

        this.appThumbnails = {};
        this.divider = new St.Bin({ style_class: 'app-window-switcher-divider',
                                    y_fill: true });
        this.appContainer.add_actor(this.divider);
        this._refresh();

        this.addActor(this.appContainer);
    },

    setMetaWindow: function(metaWindow) {
        this.metaWindow = metaWindow;
    },

    _connectToWindowOpen: function(actor, metaWindow) {
        actor._button_release_signal_id = actor.connect('button-release-event', Lang.bind(this, function() {
            metaWindow.activate(global.get_current_time());
        }));
    },

    _refresh: function() {
        // Check to see if this.metaWindow has changed.  If so, we need to recreate
        // our thumbnail, etc.
        if (this.metaWindowThumbnail && this.metaWindowThumbnail.metaWindow == this.metaWindow) {
            this.metaWindowThumbnail._refresh();
        } else {
            if (this.metaWindowThumbnail) {
                this.metaWindowThumbnail.actor.disconnect(this.metaWindowThumbnail.actor._button_release_signal_id);
                this.metaWindowThumbnail.destroy();
            }
            // If our metaWindow is null, just move along
            if (this.metaWindow) {
                this.metaWindowThumbnail = new WindowThumbnail(this.metaWindow, this.app);
                this._connectToWindowOpen(this.metaWindowThumbnail.actor, this.metaWindow);
                this.appContainer.insert_actor(this.metaWindowThumbnail.actor, 0);
            }
        }

        // Get a list of all windows of our app that are running in the current workspace
        let windows = this.app.get_windows().filter(Lang.bind(this, function(win) {
                                                            let metaWorkspace = null;
                                                            if (this.metaWindow)
                                                                metaWorkspace = this.metaWindow.get_workspace();
                                                            let isDifferent = (win != this.metaWindow);
                                                            let isSameWorkspace = (win.get_workspace() == metaWorkspace);
                                                            return isDifferent && isSameWorkspace;
                                                    }));
        // Update appThumbnails to include new programs
        windows.forEach(Lang.bind(this, function(metaWindow) {
            if (this.appThumbnails[metaWindow]) {
                this.appThumbnails[metaWindow].thumbnail._refresh();
            } else {
                let thumbnail = new WindowThumbnail(metaWindow, this.app);
                this.appThumbnails[metaWindow] = { metaWindow: metaWindow,
                                                   thumbnail: thumbnail };
                this.appContainer.add_actor(this.appThumbnails[metaWindow].thumbnail.actor);
                this._connectToWindowOpen(this.appThumbnails[metaWindow].thumbnail.actor, metaWindow);
            }
        }));

        // Update appThumbnails to remove old programs
        for (let win in this.appThumbnails) {
            if (windows.indexOf(this.appThumbnails[win].metaWindow) == -1) {
                this.appContainer.remove_actor(this.appThumbnails[win].thumbnail.actor);
                this.appThumbnails[win].thumbnail.destroy();
                delete this.appThumbnails[win];
            }
        }

        // Show the divider if there is more than one window belonging to this app
        if (Object.keys(this.appThumbnails).length > 0) {
            this.divider.show();
        } else {
            this.divider.hide();
        }
    }
};

function WindowThumbnail() {
    this._init.apply(this, arguments);
}

WindowThumbnail.prototype = {
    _init: function (metaWindow, app, params) {
        this.metaWindow = metaWindow;
        this.app = app;

        // Inherit the theme from the alt-tab menu
        this.actor = new St.BoxLayout({ style_class: 'window-thumbnail',
                                        reactive: true,
                                        can_focus: true,
                                        vertical: true });
        this.thumbnailActor = new St.Bin({ y_fill: false,
                                           y_align: St.Align.MIDDLE });
        this.thumbnailActor.height = THUMBNAIL_DEFAULT_SIZE;
        this.titleActor = new St.Label();
        //TODO: should probably do this in a smarter way in the get_size_request event or something...
        //fixing this should also allow the text to be centered
        this.titleActor.width = THUMBNAIL_DEFAULT_SIZE;

        this._setupWindowOptions();
        // simulate hide without losing height.
        this.windowOptions.reactive = false;
        this.windowOptions.opacity = 0;

        this.actor.add(this.thumbnailActor);
        this.actor.add(this.titleActor);

        this._refresh();

        // the thumbnail actor will automatically reflect changes in the window
        // (since it is a clone), but we need to update the title when it changes
        this.metaWindow.connect('notify::title', Lang.bind(this, function(){
                                                    this.titleActor.text = this.metaWindow.get_title();
                                }));
        this.actor.connect('enter-event', Lang.bind(this, function() {
            this.actor.add_style_pseudo_class('hover');
            this.actor.add_style_pseudo_class('selected');
            Tweener.addTween(this.windowOptions,
                { opacity: 255,
                  time: Overview.ANIMATION_TIME,
                  transition: 'easeOutQuad',
                  onComplete: Lang.bind(this, function () {
                      this.windowOptions.reactive = true;
                  })
                });
        }));
        this.actor.connect('leave-event', Lang.bind(this, function() {
            this.actor.remove_style_pseudo_class('hover');
            this.actor.remove_style_pseudo_class('selected');
            Tweener.addTween(this.windowOptions,
                { opacity: 0,
                  time: Overview.ANIMATION_TIME,
                  transition: 'easeOutQuad',
                  onComplete: Lang.bind(this, function () {
                      this.windowOptions.reactive = false;
                  })
                });
        }));
    },

    _setupWindowOptions: function () {
        /* Stuff for window options */
        this._buttonInfo = [ 'ALWAYS_ON_TOP', 'ALWAYS_ON_VISIBLE_WORKSPACE',
            'MOVE', 'RESIZE', 'MINIMIZE', 'MAXIMIZE', 'CLOSE_WINDOW' ];
        if (!Wnck) {
            for (let i = 0; i < WnckOptions.length; ++i) {
                let j = this._buttonInfo.indexOf(WnckOptions[i]);
                if (j >= 0) {
                    this._buttonInfo.splice(j, 1);
                }
            }
            this.wnckWindow = null;
        } else {

        /* try to get this.metaWindow as Wnck window. Compare
         * by window name and app and size/position.
         * If you have two windows with the same title (like two terminals at
         * home directory) exactly on top of each other, then too bad for you.
         */
            Wnck.Screen.get_default().force_update(); // make sure window list is up to date
            let windows = Wnck.Screen.get_default().get_windows();
            for (let i = 0; i < windows.length; ++i) {
                if (windows[i].get_name() === this.metaWindow.title &&
                        // cannot compare app name as Wnck "uses suboptimal heuristics":
                        // e.g. Chromium (wnck) vs Chromium Web Browser (this.app)
                        //windows[i].get_application().get_name() === this.app.get_name() &&
                        windows[i].get_pid() === this.metaWindow.get_pid()) {
                    let rect = this.metaWindow.get_outer_rect();
                    // if window is undecorated we must compare client_window_geometry.
                    let [x, y, width, height] = (this.metaWindow.decorated ? 
                            windows[i].get_geometry() :
                            windows[i].get_client_window_geometry());
                    if (rect.x === x && rect.y === y && rect.width === width &&
                            rect.height === height) {
                        this.wnckWindow = windows[i];        
                        break;
                    }
                }
            }
            if (!this.wnckWindow) {
                log("couldn't find the wnck window corresponding to this.metaWindow");
                for (let i = 0; i < WnckOptions.length; ++i) {
                    let j = this._buttonInfo.indexOf(WnckOptions[i]);
                    if (j >= 0) {
                        this._buttonInfo.splice(j, 1);
                    }
                }
            }
        }

        /* Add buttons */
        this.windowOptions = new St.BoxLayout({reactive: true, vertical: false});
        this._windowOptionItems = {};
        this._windowOptionIDs = [];
        for (let i = 0; i < this._buttonInfo.length; ++i) {
            let op = this._buttonInfo[i],
                buttonInfo = WindowOptions[op],
                button = new St.Button({
                    name: op,
                    style_class: 'window-options-button',
                    label: buttonInfo.symbol,
                    reactive: true // <-- necessary?
                });
            button.set_track_hover(true);
            button._hoverLabels = [buttonInfo.label];
            button._parent = this;
            button._toggled = false;
            if (buttonInfo.isToggled) {
                button._hoverLabels.push(WindowOptions[buttonInfo.toggleOff].label);
            }
            button.connect('enter-event', Lang.bind(button, function () {
                this.add_style_pseudo_class('hover');
                this._parent.titleActor.text = this._hoverLabels[+this._toggled];
            }));
            button.connect('leave-event', Lang.bind(button, function () {
                this.remove_style_pseudo_class('hover');
                this._parent.titleActor.text = this._parent.metaWindow.get_title();
            }));
            this._windowOptionIDs.push(
                button.connect('clicked',
                    Lang.bind(this, this._onActivateWindowOption, op)));
            this.windowOptions.add(button);
            this._windowOptionItems[op] = button;
        }
        this._updateWindowOptions();

        this.actor.add(this.windowOptions, {expand: false, x_fill: false, 
            x_align: St.Align.MIDDLE});
    },

    /* Every time the hover menu is shown update the always on top/visible workspace
     * items to match their actual state (in case the user changed it by other
     * means in the meantime)
     */
    _updateWindowOptions: function () {
        // update labels:
        let toUpdate = ['MAXIMIZE', 'ALWAYS_ON_TOP', 'ALWAYS_ON_VISIBLE_WORKSPACE'];
        for (let i = 0; i < toUpdate.length; ++i) {
            let op = toUpdate[i],
                other = op,
                fun = (WindowOptions[op].metaIsToggled || WindowOptions[op].isToggled);
                //other = WindowOptions[op].toggleOff;
            if (!this._windowOptionItems[op]) {
                return false;
            }
            if (fun(this.metaWindow)) {
                this._windowOptionItems[op].add_style_pseudo_class('toggled');
                this._windowOptionItems[op]._toggled = true;
                other = WindowOptions[op].toggleOff;
                // change symbol.
                this._windowOptionItems[op].label = WindowOptions[other].symbol;
            } else {
                this._windowOptionItems[op].remove_style_pseudo_class('toggled');
                this._windowOptionItems[op]._toggled = false;
                // change symbol back.
                this._windowOptionItems[op].label = WindowOptions[op].symbol;
            }
            // change hover label to the opposite one, *IF* our cursor has not left
            if (this._windowOptionItems[op].has_style_pseudo_class('hover')) {
                this.titleActor.text = WindowOptions[other].label;
            }
        }
        return false;
    },

    _onActivateWindowOption: function(button, dummy, op) {
        let win = ((op === 'ALWAYS_ON_TOP' ||
                    op === 'NOT_ALWAYS_ON_TOP' ||
                    op === 'ALWAYS_ON_VISIBLE_WORKSPACE' ||
                    op === 'ALWAYS_ON_THIS_WORKSPACE') ?
                this.wnckWindow : this.metaWindow);
        if (!win) {
            log('No window');
            return;
        }
        if (!WindowOptions[op]) {
            log("Unrecognized operation '%s'".format(op === undefined ? 'undefined' : op));
            return;
        }
        if (this._windowOptionItems[op]._toggled) {
            op = WindowOptions[op].toggleOff;
        }
        /*
        if (WindowOptions[op].isToggled && WindowOptions[op].isToggled(win)) {
        }
        */
        WindowOptions[op].action(win);
        // bah: need this for the .make_above() (etc) to go through.
        // But I think there is a noticable delay.
        Mainloop.idle_add(Lang.bind(this, this._updateWindowOptions));
    },

    destroy: function() {
        this.actor.destroy();
    },

    needs_refresh: function() {
        return Boolean(this.thumbnail);
    },

    _getThumbnail: function() {
        // Create our own thumbnail if it doesn't exist
        if (this.thumbnail) {
            return this.thumbnail;
        }

        let thumbnail = null;
        let mutterWindow = this.metaWindow.get_compositor_private();
        if (mutterWindow) {
            let windowTexture = mutterWindow.get_texture();
            let [width, height] = windowTexture.get_size();
            let scale = Math.min(1.0, THUMBNAIL_DEFAULT_SIZE / width, THUMBNAIL_DEFAULT_SIZE / height);
            thumbnail = new Clutter.Clone ({ source: windowTexture,
                                             reactive: true,
                                             width: width * scale,
                                             height: height * scale });
        }

        return thumbnail;
    },

    _refresh: function() {
        /*
        if (this.wnckWindow) {
            this._updateWindowOptions();
        }
        */
        // Replace the old thumbnail
        this.thumbnail = this._getThumbnail();

        this.thumbnailActor.child = this.thumbnail;
        this.titleActor.text = this.metaWindow.get_title();
    }
};


// A right click menu for AppGroup's.  Gives the option to
// expand/collapse an AppGroup and a few other things
function RightClickAppPopupMenu() {
    this._init.apply(this, arguments);
}

RightClickAppPopupMenu.prototype = {
    __proto__: RightClickPopupMenu.prototype,

    _init: function(actor, appGroup, params) {
        RightClickPopupMenu.prototype._init.call(this, actor, params);

        this.appGroup = appGroup;
        this.app = this.appGroup.app;

        this._menuItemName = new PopupMenu.PopupMenuItem(this.app.get_name(), { reactive: false });
        this.addMenuItem(this._menuItemName);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        /* Window options */
        this._buttonInfo = ['MINIMIZE', 'MAXIMIZE', 'MOVE', 'RESIZE', 'CLOSE_WINDOW'];
        // only display if the group is expanded
        this._displayWindowOptionsMenu(!this.appGroup.appButtonVisible);
        /* /End window options */

        this._menuItemExpandGroup = new PopupMenu.PopupMenuItem("Expand Group");
        this._menuItemExpandGroup.connect('activate', Lang.bind(this, this._onMenuItemExpandGroup));
        this.addMenuItem(this._menuItemExpandGroup);
        this._menuItemConsolidateGroup = new PopupMenu.PopupMenuItem("Consolidate Group");
        this._menuItemConsolidateGroup.connect('activate', Lang.bind(this, this._onMenuItemConsolidateGroup));
        this.addMenuItem(this._menuItemConsolidateGroup);

        // I am really afraid of accidentally clicking this menu option. . .
//        this._menuItemCloseWindow = new PopupMenu.PopupMenuItem('Close All Windows');
//        this._menuItemCloseWindow.connect('activate', Lang.bind(this, this._onMenuItemCloseWindowActivate));
//        this.addMenuItem(this._menuItemCloseWindow);
    },

    _makeWindowOptionsMenu: function () {
        if (this._windowOptionsSubMenu) {
            return;
        }
        this._windowOptionItems = {};
        this._windowOptionsSubMenu = new PopupMenu.PopupMenuSection();
        this._windowOptionsSubMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (let i = 0; i < this._buttonInfo.length; ++i) {
            let op = this._buttonInfo[i];
            this._windowOptionItems[op] = new PopupMenu.PopupMenuItem(
                    WindowOptions[op].label);
            this._windowOptionItems[op].connect('activate',
                Lang.bind(this, this._onActivateWindowOption, op));
            this._windowOptionsSubMenu.addMenuItem(this._windowOptionItems[op]);
        }
    },

    _displayWindowOptionsMenu: function (display) {
        if (display) {
            // make a new one and add it
            this._makeWindowOptionsMenu();
            this.addMenuItem(this._windowOptionsSubMenu);
        } else {
            // remove it
            if (this._windowOptionsSubMenu) {
                this._windowOptionsSubMenu.destroy();
                this._windowOptionsSubMenu = null;
            }
        }
    },

    _onActivateWindowOption: function(button, event, op) {
        /* affect the window our mouse was over when we right-clicked */
        let metaWindow = this.metaWindow;
        if (!metaWindow) {
            log('could not determine which window your mouse was over when you right-clicked');
            this._forgetButtonClicked();
            return;
        }
        if (!WindowOptions[op]) {
            log("Unrecognized operation '%s'".format(op === undefined ? 'undefined' : op));
            return;
        }
        if (WindowOptions[op].isToggled && WindowOptions[op].isToggled(metaWindow)) {
            op = WindowOptions[op].toggleOff;
        }
        WindowOptions[op].action(metaWindow);
        this._forgetButtonClicked();
    },

    /* Every time the hover menu is shown update the always on top/visible workspace
     * items to match their actual state (in case the user changed it by other
     * means in the meantime)
     */
    _updateWindowOptions: function (menu) {
        // the only one I need to update is maximize/restore, but this extends
        // to the others.
        let toCheck = ['MAXIMIZE']; // , 'ALWAYS_ON_VISIBLE_WORKSPACE', 'ALWAYS_ON_TOP'];
        for (let i = 0; i < toCheck.length; ++i) {
            let op = toCheck[i],
                other = op;
            if (!WindowOptions[op] || !this._windowOptionItems[op]) {
                continue;
            }
            if (WindowOptions[op].isToggled(this.metaWindow)) {
                other = WindowOptions[op].toggleOff;
            }
            // show the opposite label to the toggle state
            this._windowOptionItems[op].label.text = WindowOptions[other].label;
        }
    },

    /* OVERRIDE parent implementation to determine which WindowButton to affect */
    _onParentActorButtonRelease: function(actor, event) {
        RightClickPopupMenu.prototype._onParentActorButtonRelease.call(this, actor, event);
        // if the right-click menu is open, indicate to the user which window will be
        // affected by it.
        if (this.isOpen) {
            this._forgetButtonClicked();
            if (!this.appGroup.appButtonVisible) {
                /* Try to work out which window we are hovering over */
                let [x, y] = event.get_coords(),
                    result = false;
                //log(x + ', ' + y);
                [result, x, y] = this._parentActor.transform_stage_point(x, y);
                if (!result) {
                    log('could not transform stage point to actor-relative point');
                    return;
                }
                //log(x + ', ' + y);

                this.metaWindow = null;
                // work out which child the click fell in.
                if (x >= this._parentActor.width || x < 0) {
                    return;
                    log('could not find the window');
                }
                let i,
                    child = null,
                    children = this._parentActor._delegate._windowButtonBox.actor.get_children();
                for (i = 0; i < children.length; ++i) {
                    child = children[i];
                    x -= child.width;
                    if (x <= 0) {
                        child._originalWidth = child.width;
                        break;
                    }
                }

                this._parentActor._delegate._windowButtonBox.expandChild(i);
                // what about expanding that button out to its full width?
                this.metaWindow = (child._delegate ? child._delegate.metaWindow : null);
                //log('metaWindow: ' + child);
                this._updateWindowOptions();
            }
        }
    },

    // UPTO: if you cancel the menu by clicking outside, it doesn't forget!
    close: function(animate) {
        RightClickPopupMenu.prototype.close.call(this, animate);
        Mainloop.idle_add(Lang.bind(this, this._forgetButtonClicked));
    },

    _forgetButtonClicked: function () {
        this.metaWindow = null;
        this._parentActor._delegate._windowButtonBox.undoExpand();
        return false;
    },

    // TODO: when user exits without selecting we must forget.


    _onMenuItemExpandGroup: function() {
        this.appGroup.showWindowButtons(true);
        this.appGroup.hideAppButton(true);
        this._displayWindowOptionsMenu(true);
    },

    _onMenuItemConsolidateGroup: function() {
        this.appGroup.hideWindowButtons(true);
        this.appGroup.showAppButton(true);
        this._displayWindowOptionsMenu(false);
    },

    _onMenuItemCloseWindowActivate: function() {
        this.app.request_quit();
    },

    open: function(animate) {
        if (this.appGroup.appButtonVisible) {
            this._menuItemExpandGroup.actor.show();
        } else {
            this._menuItemExpandGroup.actor.hide();
        }
        if (this.appGroup.windowButtonsVisible) {
            this._menuItemConsolidateGroup.actor.show();
        } else {
            this._menuItemConsolidateGroup.actor.hide();
        }
        RightClickPopupMenu.prototype.open.call(this, animate);
    },

    generateThumbnail: function() {
        // If we already made a thumbnail, we don't need to make it again
        if (this.thumbnail) {
            return;
        }

        // Get a pretty thumbnail of our app
        let mutterWindow = this.metaWindow.get_compositor_private();
        if (mutterWindow) {
            let windowTexture = mutterWindow.get_texture();
            let [width, height] = windowTexture.get_size();
            let scale = Math.min(1.0, THUMBNAIL_DEFAULT_SIZE / width, THUMBNAIL_DEFAULT_SIZE / height);
            this.thumbnail = new Clutter.Clone ({ source: windowTexture,
                                                  reactive: true,
                                                  width: width * scale,
                                                  height: height * scale });

            this.thumnailMenuItem = new PopupMenuThumbnailItem(this.thumbnail);
            this.addMenuItem(this.thumnailMenuItem);
            this.thumnailMenuItem.connect('activate', Lang.bind(this, function() {
                this.metaWindow.activate(global.get_current_time());
            }));
        }
    }
};
