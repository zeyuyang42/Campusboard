//! Closing the main window while it is in native full screen.
//!
//! The close button and ⌘W hide the main window (persist.ts). Hiding a window in native
//! full screen leaves its Space behind, black and empty, so the window first leaves full
//! screen and hides once AppKit says the transition is over
//! (`NSWindowDidExitFullScreenNotification`). The end can't be read from tao: its
//! `set_fullscreen(None)` clears the full-screen state at once (tao 0.37 window.rs), so
//! `is_fullscreen()` is false for the whole animation, and a close during the enter
//! transition is queued by tao and only starts after `windowDidEnterFullScreen:`.

use std::sync::Mutex;
use tauri::{AppHandle, Runtime, WebviewWindow};

/// What a close does now.
#[derive(Debug, PartialEq)]
enum Close {
    /// Not full screen and nothing pending: hide at once.
    HideNow,
    /// Full screen: leave it, and `finish` when AppKit says it is out (or the fallback fires).
    StartExit,
    /// An exit is already under way (tao reports "not full screen" by then, so hiding now
    /// would hide mid-animation): its `finish` decides.
    Wait,
}

/// The pending-hide bookkeeping, kept pure so the rules can be tested.
#[derive(Default)]
struct HideState {
    pending: bool,
    /// Bumped by every reveal of the main window.
    reveals: u64,
    /// The `reveals` count the last close saw: a reveal after it cancels the late hide,
    /// and a close after that reveal re-arms it.
    hide_at: u64,
}

impl HideState {
    fn close(&mut self, fullscreen: bool) -> Close {
        self.hide_at = self.reveals;
        if self.pending {
            Close::Wait
        } else if fullscreen {
            self.pending = true;
            Close::StartExit
        } else {
            Close::HideNow
        }
    }

    fn revealed(&mut self) {
        self.reveals += 1;
    }

    /// The exit is over (or could not start): whether to hide now.
    fn finish(&mut self) -> bool {
        self.pending = false;
        self.reveals == self.hide_at
    }
}

static STATE: Mutex<HideState> = Mutex::new(HideState { pending: false, reveals: 0, hide_at: 0 });

fn state() -> std::sync::MutexGuard<'static, HideState> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Called by `reveal()` for the main window (Dock reopen, menu, mini player's Show).
pub fn revealed() {
    state().revealed();
}

/// End the wait: hide unless the window was revealed after the last close asked for it.
fn finish_pending<R: Runtime>(w: &WebviewWindow<R>) {
    if state().finish() {
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
    let fullscreen = w.is_fullscreen().unwrap_or(false);
    // Bound to a variable so the lock is released before anything below takes it again.
    let action = state().close(fullscreen);
    match action {
        Close::HideNow => w.hide().map_err(|e| e.to_string()),
        Close::Wait => Ok(()),
        Close::StartExit => exit_then_hide(app, w).inspect_err(|_| {
            state().finish();
        }),
    }
}

/// Show the main window through `reveal()`, so a hide still waiting on full screen is
/// cancelled (the mini player's Show, miniBridge.ts).
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::menu::show_main(&app);
}

#[cfg(not(target_os = "macos"))]
fn exit_then_hide<R: Runtime>(_app: AppHandle<R>, w: WebviewWindow<R>) -> Result<(), String> {
    let _ = w.set_fullscreen(false);
    finish_pending(&w);
    Ok(())
}

#[cfg(target_os = "macos")]
fn exit_then_hide<R: Runtime>(app: AppHandle<R>, w: WebviewWindow<R>) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    let ns_window = w.ns_window().map_err(|e| e.to_string())? as usize;
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
    // Sync commands run on the main thread, where run_on_main_thread runs the closure
    // inline: the observer is registered before set_fullscreen, and before this returns.
    app.run_on_main_thread(move || {
        let fire_app = main.clone();
        let observer = macos::observe_exit(ns_window, Box::new(move |observer: usize| {
            if fire_done.swap(true, Ordering::SeqCst) {
                return;
            }
            // Really deferred: called from the main thread, run_on_main_thread would run
            // inline and release the observer while its own method is still running. From
            // another thread it is queued for a later turn of the event loop, after AppKit
            // has finished the transition that posted the notification.
            std::thread::spawn(move || {
                let _ = fire_app.run_on_main_thread(move || {
                    fire_hide();
                    // SAFETY: the +1 reference observe_exit handed out; removed from the
                    // notification center already, and nothing else holds this pointer.
                    unsafe { macos::release(observer) };
                });
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
    .map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windowed_close_hides_at_once() {
        let mut s = HideState::default();
        assert_eq!(s.close(false), Close::HideNow);
        assert!(!s.pending);
    }

    #[test]
    fn a_full_screen_close_hides_when_the_exit_finishes() {
        let mut s = HideState::default();
        assert_eq!(s.close(true), Close::StartExit);
        assert!(s.finish());
    }

    #[test]
    fn a_reveal_during_the_wait_cancels_the_late_hide() {
        let mut s = HideState::default();
        assert_eq!(s.close(true), Close::StartExit);
        s.revealed();
        assert!(!s.finish());
    }

    #[test]
    fn a_close_after_that_reveal_hides_again_when_the_wait_ends() {
        let mut s = HideState::default();
        assert_eq!(s.close(true), Close::StartExit);
        s.revealed();
        // tao already says "not full screen": the second close must still wait.
        assert_eq!(s.close(false), Close::Wait);
        assert!(s.finish());
    }

    #[test]
    fn a_second_close_while_pending_starts_no_second_exit() {
        let mut s = HideState::default();
        assert_eq!(s.close(true), Close::StartExit);
        assert_eq!(s.close(true), Close::Wait);
        assert!(s.finish());
        // Over: the next close is a fresh one.
        assert_eq!(s.close(false), Close::HideNow);
    }
}
