//! Closing the main window while it is in native full screen (#118).
//!
//! The close button and ⌘W hide the main window (persist.ts). Hiding a window in native
//! full screen leaves its Space behind, black and empty, so the window first leaves full
//! screen and hides once AppKit says the transition is over
//! (`NSWindowDidExitFullScreenNotification`). The end can't be read from tao: its
//! `set_fullscreen(None)` clears the full-screen state at once (tao 0.37 window.rs), so
//! `is_fullscreen()` is false for the whole animation, and a close during the enter
//! transition is queued by tao and only starts after `windowDidEnterFullScreen:`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Runtime, WebviewWindow};

/// Bumped by every `reveal()` of the main window, so a hide still waiting on full screen
/// is dropped when the window was shown again in between (Dock reopen during the wait).
static REVEALS: AtomicU64 = AtomicU64::new(0);

pub fn revealed() {
    REVEALS.fetch_add(1, Ordering::SeqCst);
}

/// A close is waiting for the window to leave full screen. tao already reports "not full
/// screen" then, so a second close must not hide at once (mid-animation): it only updates
/// `HIDE_AT`, so a close after a reveal during the wait still hides when the wait ends.
static PENDING: AtomicBool = AtomicBool::new(false);
/// The `REVEALS` count the pending hide is for.
static HIDE_AT: AtomicU64 = AtomicU64::new(0);

/// End the wait: hide unless the window was revealed after the last close asked for it.
fn finish_pending<R: Runtime>(w: &WebviewWindow<R>) {
    PENDING.store(false, Ordering::SeqCst);
    if REVEALS.load(Ordering::SeqCst) == HIDE_AT.load(Ordering::SeqCst) {
        let _ = w.hide();
    }
}

/// How long a close waits for the exit notification before it hides anyway.
#[cfg(target_os = "macos")]
const FALLBACK: std::time::Duration = std::time::Duration::from_secs(2);

/// Hide the main window, leaving native full screen first when it is in it.
#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let w = crate::main_window(&app).ok_or("no main window")?;
    HIDE_AT.store(REVEALS.load(Ordering::SeqCst), Ordering::SeqCst);
    if PENDING.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !w.is_fullscreen().unwrap_or(false) {
        return w.hide().map_err(|e| e.to_string());
    }
    exit_then_hide(app, w)
}

#[cfg(not(target_os = "macos"))]
fn exit_then_hide<R: Runtime>(_app: AppHandle<R>, w: WebviewWindow<R>) -> Result<(), String> {
    let _ = w.set_fullscreen(false);
    w.hide().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn exit_then_hide<R: Runtime>(app: AppHandle<R>, w: WebviewWindow<R>) -> Result<(), String> {
    use std::sync::Arc;

    let ns_window = w.ns_window().map_err(|e| e.to_string())? as usize;
    PENDING.store(true, Ordering::SeqCst);
    // Whoever flips this first (the notification or the fallback) removes the observer,
    // hides and releases it; the other does nothing.
    let done = Arc::new(AtomicBool::new(false));
    let hide = {
        let w = w.clone();
        move || finish_pending(&w)
    };

    let main = app.clone();
    let fire_done = done.clone();
    let fire_hide = hide.clone();
    app.run_on_main_thread(move || {
        let fire_app = main.clone();
        let observer = macos::observe_exit(ns_window, Box::new(move |observer: usize| {
            if fire_done.swap(true, Ordering::SeqCst) {
                return;
            }
            // Deferred to the next turn of the event loop: AppKit is still finishing the
            // transition while it posts the notification, and the observer is still
            // running its own method.
            let _ = fire_app.run_on_main_thread(move || {
                fire_hide();
                // SAFETY: the +1 reference observe_exit handed out; removed from the
                // notification center already, and nothing else holds this pointer.
                unsafe { macos::release(observer) };
            });
        }));
        let _ = w.set_fullscreen(false);

        let late = main.clone();
        std::thread::spawn(move || {
            std::thread::sleep(FALLBACK);
            let _ = late.run_on_main_thread(move || {
                if done.swap(true, Ordering::SeqCst) {
                    return;
                }
                // SAFETY: the observer has not fired (done was false), so it is still
                // registered and its +1 reference is still ours; this is the main thread.
                unsafe {
                    macos::stop_observing(observer);
                    macos::release(observer);
                }
                hide();
            });
        });
    })
    .map_err(|e| {
        PENDING.store(false, Ordering::SeqCst);
        e.to_string()
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, NSObject};
    use objc2::{class, define_class, msg_send, sel, AllocAnyThread, DefinedClass};
    use std::cell::Cell;

    /// Called once with the observer's own pointer, when the notification arrives.
    type Fire = Box<dyn FnOnce(usize)>;

    pub struct Ivars {
        fire: Cell<Option<Fire>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and ExitObserver has no Drop.
        #[unsafe(super(NSObject))]
        #[name = "CampusboardFullscreenExitObserver"]
        #[ivars = Ivars]
        pub struct ExitObserver;

        impl ExitObserver {
            #[unsafe(method(windowDidExitFullScreen:))]
            fn window_did_exit(&self, _note: *mut AnyObject) {
                let me = self as *const Self as usize;
                // SAFETY: called by the notification center on the main thread.
                unsafe { stop_observing(me) };
                if let Some(fire) = self.ivars().fire.take() {
                    fire(me);
                }
            }
        }
    );

    /// Start observing `NSWindowDidExitFullScreenNotification` from `ns_window` (main
    /// thread). Returns the observer with a +1 reference the caller must `release`.
    pub fn observe_exit(ns_window: usize, fire: Fire) -> usize {
        let this = ExitObserver::alloc().set_ivars(Ivars { fire: Cell::new(Some(fire)) });
        // SAFETY: plain NSObject init; the notification center calls the selector with one
        // object argument, as the method is declared; the window pointer is tao's live
        // NSWindow, and this runs on the main thread.
        unsafe {
            let observer: Retained<ExitObserver> = msg_send![super(this), init];
            let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
            // The value of the AppKit constant is its own name.
            let name: *mut AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: c"NSWindowDidExitFullScreenNotification".as_ptr()];
            if let Some(center) = center.as_ref() {
                let _: () = msg_send![
                    center,
                    addObserver: &*observer,
                    selector: sel!(windowDidExitFullScreen:),
                    name: name,
                    object: ns_window as *mut AnyObject
                ];
            }
            Retained::into_raw(observer) as usize
        }
    }

    /// Remove the observer from the default center (main thread). Removing twice is fine.
    pub unsafe fn stop_observing(observer: usize) {
        let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
        if let Some(center) = center.as_ref() {
            let _: () = msg_send![center, removeObserver: observer as *mut AnyObject];
        }
    }

    /// Give back the +1 reference from `observe_exit`.
    pub unsafe fn release(observer: usize) {
        drop(Retained::from_raw(observer as *mut ExitObserver));
    }
}
