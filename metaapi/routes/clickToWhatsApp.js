const express = require('express');
const router = express.Router();
const ClickToWhatsAppService = require('../services/ClickToWhatsApp');
const { getPageToken } = require('../../utils/tokenExchange');

// Create Campaign
router.post('/campaigns', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...campaignData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToWhatsAppService.createCampaign(
      act_ad_account_id,
      fb_token,
      campaignData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating WhatsApp campaign:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Ad Set
router.post('/adsets', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...adsetData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToWhatsAppService.createAdSet(
      act_ad_account_id,
      fb_token,
      adsetData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating WhatsApp ad set:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Ad Creative
router.post('/adcreatives', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...creativeData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToWhatsAppService.createAdCreative(
      act_ad_account_id,
      fb_token,
      creativeData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating WhatsApp ad creative:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Create Ad
router.post('/ads', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...adData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToWhatsAppService.createAd(
      act_ad_account_id,
      fb_token,
      adData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating WhatsApp ad:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

// Verify WhatsApp Number
router.post('/verify-whatsapp-number', async (req, res) => {
  try {
    const { page_id, fb_token, whatsapp_number, verification_code } = req.body;

    if (!page_id || !fb_token || !whatsapp_number) {
      return res.status(400).json({
        error: 'Missing required fields: page_id, fb_token, and whatsapp_number are required'
      });
    }

    // Get page access token
    const pageAccessToken = await getPageToken(fb_token, page_id);

    // Prepare verification data
    const verificationData = {
      whatsapp_number
    };
    if (verification_code) {
      verificationData.verification_code = verification_code;
    }

    const result = await ClickToWhatsAppService.verifyWhatsAppNumber(
      page_id,
      pageAccessToken,
      verificationData
    );

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error verifying WhatsApp number:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

module.exports = router;
