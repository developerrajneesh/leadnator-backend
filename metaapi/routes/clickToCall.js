const express = require('express');
const router = express.Router();
const ClickToCallService = require('../services/ClickToCall');

// Create Campaign
router.post('/campaigns', async (req, res) => {
  try {
    const { act_ad_account_id, fb_token, ...campaignData } = req.body;

    if (!act_ad_account_id || !fb_token) {
      return res.status(400).json({
        error: 'Missing required fields: act_ad_account_id and fb_token are required in request body'
      });
    }

    const result = await ClickToCallService.createCampaign(
      act_ad_account_id,
      fb_token,
      campaignData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating campaign:', error);
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

    const result = await ClickToCallService.createAdSet(
      act_ad_account_id,
      fb_token,
      adsetData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating ad set:', error);
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

    const result = await ClickToCallService.createAdCreative(
      act_ad_account_id,
      fb_token,
      creativeData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating ad creative:', error);
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

    const result = await ClickToCallService.createAd(
      act_ad_account_id,
      fb_token,
      adData
    );

    res.status(201).json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error creating ad:', error);
    console.error('Request body:', req.body);
    
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

module.exports = router;
