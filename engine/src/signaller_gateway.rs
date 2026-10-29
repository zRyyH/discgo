//! P2P signaller for `webrtcsink` (PLAN 6.5): instead of talking to a signalling
//! server it turns SDP/ICE into stdout events, which the shell relays through the
//! gateway to the single viewer, and receives the viewer's answer/candidates back
//! as stdin commands.

use gst::glib;
use gst::glib::subclass::prelude::*;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_sdp as gst_sdp;
use gstreamer_webrtc as gst_webrtc;
use gstrswebrtc::signaller::Signallable;

use crate::protocol::{Event, SdpKind};

glib::wrapper! {
    pub struct GatewaySignaller(ObjectSubclass<imp::GatewaySignaller>) @implements Signallable;
}

impl GatewaySignaller {
    pub fn new(session_id: &str) -> Self {
        let obj: Self = glib::Object::new();
        *obj.imp().session_id.lock().unwrap() = session_id.to_owned();
        obj
    }

    /// Answer from the viewer.
    pub fn handle_sdp(&self, session_id: &str, kind: SdpKind, sdp: &str) -> anyhow::Result<()> {
        anyhow::ensure!(kind == SdpKind::Answer, "engine only accepts answers");
        let msg = gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes())?;
        let desc =
            gst_webrtc::WebRTCSessionDescription::new(gst_webrtc::WebRTCSDPType::Answer, msg);
        self.emit_by_name::<()>("session-description", &[&session_id, &desc]);
        Ok(())
    }

    /// Remote ICE candidate from the viewer.
    pub fn handle_ice(
        &self,
        session_id: &str,
        candidate: &str,
        sdp_m_line_index: u32,
        sdp_mid: Option<String>,
    ) {
        self.emit_by_name::<()>(
            "handle-ice",
            &[&session_id, &sdp_m_line_index, &sdp_mid, &candidate],
        );
    }
}

mod imp {
    use std::sync::Mutex;

    use gstrswebrtc::signaller::{Signallable, SignallableImpl};

    use super::*;

    #[derive(Default)]
    pub struct GatewaySignaller {
        pub session_id: Mutex<String>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for GatewaySignaller {
        const NAME: &'static str = "DiscgoGatewaySignaller";
        type Type = super::GatewaySignaller;
        type ParentType = glib::Object;
        type Interfaces = (Signallable,);
    }

    impl ObjectImpl for GatewaySignaller {
        // Required by the Signallable interface.
        fn properties() -> &'static [glib::ParamSpec] {
            static PROPERTIES: std::sync::LazyLock<Vec<glib::ParamSpec>> =
                std::sync::LazyLock::new(|| {
                    vec![
                        glib::ParamSpecBoolean::builder("manual-sdp-munging")
                            .nick("Manual SDP munging")
                            .blurb("Whether the signaller manages SDP munging itself")
                            .default_value(false)
                            .read_only()
                            .build(),
                    ]
                });
            PROPERTIES.as_ref()
        }

        fn property(&self, _id: usize, pspec: &glib::ParamSpec) -> glib::Value {
            match pspec.name() {
                "manual-sdp-munging" => false.to_value(),
                _ => unreachable!(),
            }
        }
    }

    impl SignallableImpl for GatewaySignaller {
        fn start(&self) {
            // One consumer per P2P session: the peer. webrtcsink answers with an offer (send_sdp).
            let session_id = self.session_id.lock().unwrap().clone();
            log::info!("p2p signaller: requesting session {session_id}");
            self.obj().emit_by_name::<()>(
                "session-requested",
                &[
                    &session_id,
                    &"peer",
                    &None::<gst_webrtc::WebRTCSessionDescription>,
                ],
            );
        }

        fn stop(&self) {
            log::info!("p2p signaller: stopped");
        }

        fn send_sdp(&self, session_id: &str, sdp: &gst_webrtc::WebRTCSessionDescription) {
            let kind = match sdp.type_() {
                gst_webrtc::WebRTCSDPType::Offer => SdpKind::Offer,
                _ => SdpKind::Answer,
            };
            let text = match sdp.sdp().as_text() {
                Ok(t) => t,
                Err(e) => {
                    log::error!("p2p signaller: cannot serialize sdp: {e}");
                    return;
                }
            };
            crate::emit(&Event::Sdp {
                session_id: session_id.to_owned(),
                kind,
                sdp: text,
            });
        }

        fn add_ice(
            &self,
            session_id: &str,
            candidate: &str,
            sdp_m_line_index: u32,
            sdp_mid: Option<String>,
        ) {
            crate::emit(&Event::Ice {
                session_id: session_id.to_owned(),
                candidate: candidate.to_owned(),
                sdp_mid,
                sdp_m_line_index,
            });
        }

        fn end_session(&self, session_id: &str) {
            log::info!("p2p signaller: session {session_id} ended");
        }
    }
}
